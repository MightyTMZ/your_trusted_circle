// Push-to-talk microphone capture for the operator console. One recording per
// operator turn; the audio goes to the YTC backend for transcription.

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export class PushToTalk {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  }

  /** Asks for the microphone once; later turns reuse the stream. */
  async open(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  start(): void {
    if (!this.stream) throw new Error('microphone not open');
    if (this.recording) return;
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start();
    this.startedAt = performance.now();
  }

  /** Stops and returns the recording, and how long it was held. */
  stop(): Promise<{ audio: Blob; heldMs: number } | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== 'recording') return Promise.resolve(null);
    const heldMs = performance.now() - this.startedAt;
    return new Promise((resolve) => {
      recorder.onstop = () => resolve({ audio: new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }), heldMs });
      recorder.stop();
    });
  }

  close(): void {
    if (this.recording) this.recorder!.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}
