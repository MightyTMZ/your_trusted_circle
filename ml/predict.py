"""Load sensor_logger data, extract features, and predict motion using model.pkl."""

import os
import numpy as np
import pandas as pd
import joblib

MODEL_PATH = "model.pkl"
SENSOR_LOGGER_DIR = "sensor_logger"
WINDOW_SIZE = 128
STEP_SIZE = 64

SENSOR_COLS = [
    "attitude.roll", "attitude.pitch", "attitude.yaw",
    "gravity.x", "gravity.y", "gravity.z",
    "rotationRate.x", "rotationRate.y", "rotationRate.z",
    "userAcceleration.x", "userAcceleration.y", "userAcceleration.z",
]


def extract_window_features(window):
    """Extract the same features used during training."""
    features = []
    for col in SENSOR_COLS:
        vals = window[col].values
        features.extend([
            np.mean(vals),
            np.std(vals),
            np.min(vals),
            np.max(vals),
            np.median(vals),
        ])
    axis_groups = [
        ("attitude.roll", "attitude.pitch", "attitude.yaw"),
        ("gravity.x", "gravity.y", "gravity.z"),
        ("rotationRate.x", "rotationRate.y", "rotationRate.z"),
        ("userAcceleration.x", "userAcceleration.y", "userAcceleration.z"),
    ]
    for ax, ay, az in axis_groups:
        vx, vy, vz = window[ax].values, window[ay].values, window[az].values
        features.append(np.corrcoef(vx, vy)[0, 1] if np.std(vx) > 0 and np.std(vy) > 0 else 0.0)
        features.append(np.corrcoef(vx, vz)[0, 1] if np.std(vx) > 0 and np.std(vz) > 0 else 0.0)
        features.append(np.corrcoef(vy, vz)[0, 1] if np.std(vy) > 0 and np.std(vz) > 0 else 0.0)
    return features


def load_sensor_logger_folder(folder_path):
    """Load and merge the 4 required CSVs from a sensor_logger folder."""
    orientation = pd.read_csv(os.path.join(folder_path, "Orientation.csv"))
    gravity = pd.read_csv(os.path.join(folder_path, "Gravity.csv"))
    gyroscope = pd.read_csv(os.path.join(folder_path, "Gyroscope.csv"))
    accelerometer = pd.read_csv(os.path.join(folder_path, "Accelerometer.csv"))

    # Rename columns to match the model's expected names
    orientation = orientation.rename(columns={
        "roll": "attitude.roll",
        "pitch": "attitude.pitch",
        "yaw": "attitude.yaw",
    })[["seconds_elapsed", "attitude.roll", "attitude.pitch", "attitude.yaw"]]

    gravity = gravity.rename(columns={
        "x": "gravity.x",
        "y": "gravity.y",
        "z": "gravity.z",
    })[["seconds_elapsed", "gravity.x", "gravity.y", "gravity.z"]]

    gyroscope = gyroscope.rename(columns={
        "x": "rotationRate.x",
        "y": "rotationRate.y",
        "z": "rotationRate.z",
    })[["seconds_elapsed", "rotationRate.x", "rotationRate.y", "rotationRate.z"]]

    accelerometer = accelerometer.rename(columns={
        "x": "userAcceleration.x",
        "y": "userAcceleration.y",
        "z": "userAcceleration.z",
    })[["seconds_elapsed", "userAcceleration.x", "userAcceleration.y", "userAcceleration.z"]]

    # Merge on nearest timestamp using merge_asof
    orientation = orientation.sort_values("seconds_elapsed").reset_index(drop=True)
    gravity = gravity.sort_values("seconds_elapsed").reset_index(drop=True)
    gyroscope = gyroscope.sort_values("seconds_elapsed").reset_index(drop=True)
    accelerometer = accelerometer.sort_values("seconds_elapsed").reset_index(drop=True)

    merged = pd.merge_asof(orientation, gravity, on="seconds_elapsed", direction="nearest")
    merged = pd.merge_asof(merged, gyroscope, on="seconds_elapsed", direction="nearest")
    merged = pd.merge_asof(merged, accelerometer, on="seconds_elapsed", direction="nearest")

    return merged


def predict_folder(clf, folder_path, folder_name):
    """Run predictions on all windows in a single folder."""
    data = load_sensor_logger_folder(folder_path)
    print(f"\n{'='*50}")
    print(f"Folder: {folder_name}")
    print(f"Merged rows: {len(data)}")

    if len(data) < WINDOW_SIZE:
        print(f"Not enough data for a window (need {WINDOW_SIZE} rows, got {len(data)})")
        return

    predictions = []
    for start in range(0, len(data) - WINDOW_SIZE + 1, STEP_SIZE):
        window = data.iloc[start:start + WINDOW_SIZE]
        feats = extract_window_features(window)
        if not any(np.isnan(feats)):
            predictions.append(feats)

    if not predictions:
        print("No valid windows extracted.")
        return

    X = np.array(predictions)
    preds = clf.predict(X)

    print(f"Windows analyzed: {len(preds)}")
    print(f"\nPer-window predictions:")
    for i, pred in enumerate(preds):
        t_start = data.iloc[i * STEP_SIZE]["seconds_elapsed"]
        t_end = data.iloc[i * STEP_SIZE + WINDOW_SIZE - 1]["seconds_elapsed"]
        print(f"  Window {i+1}: {t_start:.2f}s - {t_end:.2f}s → {pred}")

    # Overall summary
    unique, counts = np.unique(preds, return_counts=True)
    print(f"\nSummary:")
    for activity, count in sorted(zip(unique, counts), key=lambda x: -x[1]):
        pct = count / len(preds) * 100
        print(f"  {activity}: {count}/{len(preds)} windows ({pct:.1f}%)")

    dominant = unique[np.argmax(counts)]
    print(f"\nDominant motion: {dominant}")


def main():
    clf = joblib.load(MODEL_PATH)
    print(f"Loaded model from {MODEL_PATH}")

    for folder_name in sorted(os.listdir(SENSOR_LOGGER_DIR)):
        folder_path = os.path.join(SENSOR_LOGGER_DIR, folder_name)
        if not os.path.isdir(folder_path):
            continue
        # Check if folder has the required CSVs
        required = ["Orientation.csv", "Gravity.csv", "Gyroscope.csv", "Accelerometer.csv"]
        if not all(os.path.exists(os.path.join(folder_path, f)) for f in required):
            print(f"\nSkipping folder {folder_name}: missing required CSV files")
            continue
        predict_folder(clf, folder_path, folder_name)


if __name__ == "__main__":
    main()
