/**
 * Collects 12 sensor features (attitude, gravity, rotation rate, user
 * acceleration) from the device, runs activity-classification inference
 * with the TFJS model in tfjs_model/, and sends predictions to the server
 * as sensor traces (stored in the MongoDB traces collection).
 *
 * Each participant in a session runs this independently on their own device.
 * The model expects 10 timesteps × 12 features = 120 inputs, Z-score
 * normalised with the training-set statistics in metadata.json.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as tf from '@tensorflow/tfjs';

// ---- types -----------------------------------------------------------------

interface Metadata {
  activities: string[];
  sensorCols: string[];
  normalization: { means: number[]; stds: number[] };
}

interface SensorSnapshot {
  attitude: { roll: number; pitch: number; yaw: number };
  gravity: { x: number; y: number; z: number };
  rotationRate: { x: number; y: number; z: number };
  userAcceleration: { x: number; y: number; z: number };
}

export interface ActivityPrediction {
  label: string;
  probabilities: Record<string, number>;
  at: number; // epoch ms
}

// ---- constants -------------------------------------------------------------

const INITIAL_SNAPSHOT: SensorSnapshot = {
  attitude: { roll: 0, pitch: 0, yaw: 0 },
  gravity: { x: 0, y: 0, z: 0 },
  rotationRate: { x: 0, y: 0, z: 0 },
  userAcceleration: { x: 0, y: 0, z: 0 },
};

const SAMPLE_INTERVAL_MS = 20; // 50 Hz
const INFERENCE_INTERVAL_MS = 5_000;

// ---- helpers ---------------------------------------------------------------

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function snapshotToRow(d: SensorSnapshot): number[] {
  return [
    d.attitude.roll,
    d.attitude.pitch,
    d.attitude.yaw,
    d.gravity.x,
    d.gravity.y,
    d.gravity.z,
    d.rotationRate.x,
    d.rotationRate.y,
    d.rotationRate.z,
    d.userAcceleration.x,
    d.userAcceleration.y,
    d.userAcceleration.z,
  ];
}

function zNormalize(flat: number[], means: number[], stds: number[]): Float32Array {
  const out = new Float32Array(flat.length);
  for (let i = 0; i < flat.length; i++) {
    out[i] = (flat[i] - means[i]) / (stds[i] || 1);
  }
  return out;
}

// ---- the hook --------------------------------------------------------------

/**
 * Runs activity inference for one participant in a session. Sensor data is
 * collected from the device's motion and orientation APIs, inference is run
 * every 5 s with the TFJS model, and the result is POSTed to `/api/ingest`
 * as a sensor trace for the MongoDB traces collection.
 *
 * @param serverId  The session's server id (null = inactive).
 * @param sessionId The session id (ses_…) for the trace.
 */
export function useActivityInference(
  serverId: string | null,
  sessionId: string | null,
): { prediction: ActivityPrediction | null } {
  const [prediction, setPrediction] = useState<ActivityPrediction | null>(null);

  const latestRef = useRef<SensorSnapshot>({ ...INITIAL_SNAPSHOT });
  const bufferRef = useRef<number[][]>([]);
  const modelRef = useRef<tf.LayersModel | null>(null);
  const metaRef = useRef<Metadata | null>(null);

  // Load model + metadata once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await tf.ready();
      const [model, metaRes] = await Promise.all([
        tf.loadLayersModel('/tfjs_model/model.json'),
        fetch('/tfjs_model/metadata.json').then((r) => r.json()) as Promise<Metadata>,
      ]);
      if (cancelled) {
        model.dispose();
        return;
      }
      modelRef.current = model;
      metaRef.current = metaRes;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Run inference on the current buffer.
  const runInference = useCallback(async (): Promise<ActivityPrediction | null> => {
    const model = modelRef.current;
    const meta = metaRef.current;
    if (!model || !meta) return null;

    const featuresPerStep = meta.sensorCols.length; // 12
    const totalFeatures = meta.normalization.means.length; // 120
    const windowSize = totalFeatures / featuresPerStep; // 10

    const buf = bufferRef.current;
    if (buf.length < windowSize) return null;

    const win = buf.slice(-windowSize);
    const flat = win.flat();
    const normalized = zNormalize(flat, meta.normalization.means, meta.normalization.stds);

    const input = tf.tensor2d(normalized, [1, totalFeatures]);
    const output = model.predict(input) as tf.Tensor;
    const probs = await output.data();

    const probabilities: Record<string, number> = {};
    let maxIdx = 0;
    for (let i = 0; i < meta.activities.length; i++) {
      probabilities[meta.activities[i]] = Math.round(probs[i] * 10_000) / 10_000;
      if (probs[i] > probs[maxIdx]) maxIdx = i;
    }

    input.dispose();
    output.dispose();

    return { label: meta.activities[maxIdx], probabilities, at: Date.now() };
  }, []);

  // Sensor listeners + sampling + inference + ingest.
  useEffect(() => {
    if (!serverId || !sessionId) return;

    const motionHandler = (event: DeviceMotionEvent) => {
      const accel = event.acceleration;
      const accelG = event.accelerationIncludingGravity;
      const rot = event.rotationRate;

      if (accel) {
        latestRef.current.userAcceleration = {
          x: accel.x ?? 0,
          y: accel.y ?? 0,
          z: accel.z ?? 0,
        };
      }
      if (accelG && accel) {
        latestRef.current.gravity = {
          x: (accelG.x ?? 0) - (accel.x ?? 0),
          y: (accelG.y ?? 0) - (accel.y ?? 0),
          z: (accelG.z ?? 0) - (accel.z ?? 0),
        };
      }
      if (rot) {
        latestRef.current.rotationRate = {
          x: rot.alpha ?? 0,
          y: rot.beta ?? 0,
          z: rot.gamma ?? 0,
        };
      }
    };

    const orientationHandler = (event: DeviceOrientationEvent) => {
      latestRef.current.attitude = {
        pitch: degToRad(event.beta ?? 0),
        roll: degToRad(event.gamma ?? 0),
        yaw: degToRad(event.alpha ?? 0),
      };
    };

    window.addEventListener('devicemotion', motionHandler);
    window.addEventListener('deviceorientation', orientationHandler);

    // 50 Hz sampling into sliding-window buffer.
    const meta = metaRef.current;
    const windowSize = meta ? meta.normalization.means.length / meta.sensorCols.length : 10;

    const sampleId = setInterval(() => {
      bufferRef.current.push(snapshotToRow({ ...latestRef.current }));
      if (bufferRef.current.length > windowSize) {
        bufferRef.current = bufferRef.current.slice(-windowSize);
      }
    }, SAMPLE_INTERVAL_MS);

    // Every 5 s: infer + send trace to MongoDB traces collection.
    const inferenceId = setInterval(async () => {
      const result = await runInference();
      if (!result) return;
      setPrediction(result);

      try {
        await fetch('/api/ingest', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [
              {
                kind: 'sensor',
                sessionId,
                occurredAt: new Date(result.at).toISOString(),
                dataOrigin: 'live_device',
                dataClass: 'derived',
                units: 'probability',
                data: {
                  type: 'activity_prediction',
                  label: result.label,
                  probabilities: result.probabilities,
                  modelVersion: 'tfjs_v1',
                  windowTimesteps: 10,
                  featuresPerTimestep: 12,
                  inferenceIntervalMs: INFERENCE_INTERVAL_MS,
                },
              },
            ],
          }),
        });
      } catch {
        // Fire-and-forget: the next interval retries with fresh data.
      }
    }, INFERENCE_INTERVAL_MS);

    return () => {
      window.removeEventListener('devicemotion', motionHandler);
      window.removeEventListener('deviceorientation', orientationHandler);
      clearInterval(sampleId);
      clearInterval(inferenceId);
      bufferRef.current = [];
    };
  }, [serverId, sessionId, runInference]);

  return { prediction };
}
