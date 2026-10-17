"""Train a Random Forest classifier for Human Activity Recognition (HAR)
using smartphone sensor data (accelerometer, gyroscope, attitude, gravity).
"""

import os
import re
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
import joblib

DATA_DIR = "archive/A_DeviceMotion_data/A_DeviceMotion_data"
WINDOW_SIZE = 128  # ~2.56s at 50Hz
STEP_SIZE = 64     # 50% overlap
MODEL_PATH = "model.pkl"

ACTIVITY_MAP = {
    "dws": "downstairs",
    "ups": "upstairs",
    "wlk": "walking",
    "jog": "jogging",
    "sit": "sitting",
    "std": "standing",
}

SENSOR_COLS = [
    "attitude.roll", "attitude.pitch", "attitude.yaw",
    "gravity.x", "gravity.y", "gravity.z",
    "rotationRate.x", "rotationRate.y", "rotationRate.z",
    "userAcceleration.x", "userAcceleration.y", "userAcceleration.z",
]


def load_data():
    """Load all CSVs, tagging each row with activity and subject ID."""
    frames = []
    for folder in os.listdir(DATA_DIR):
        folder_path = os.path.join(DATA_DIR, folder)
        if not os.path.isdir(folder_path):
            continue
        prefix = folder.split("_")[0]
        activity = ACTIVITY_MAP.get(prefix)
        if activity is None:
            continue
        for fname in os.listdir(folder_path):
            if not fname.endswith(".csv"):
                continue
            m = re.search(r"sub_(\d+)", fname)
            if not m:
                continue
            subject_id = int(m.group(1))
            df = pd.read_csv(os.path.join(folder_path, fname))
            df["activity"] = activity
            df["subject"] = subject_id
            frames.append(df)
    data = pd.concat(frames, ignore_index=True)
    print(f"Loaded {len(data)} rows from {len(frames)} files")
    return data


def extract_window_features(window):
    """Extract handcrafted features from a single window of sensor data."""
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
    # Inter-axis correlations for each 3-axis sensor group
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


def build_features(data):
    """Slide windows over each (subject, activity) segment and extract features."""
    X, y, subjects = [], [], []
    for (subj, act), group in data.groupby(["subject", "activity"]):
        group = group.sort_index()
        n = len(group)
        for start in range(0, n - WINDOW_SIZE + 1, STEP_SIZE):
            window = group.iloc[start:start + WINDOW_SIZE]
            feats = extract_window_features(window)
            if not any(np.isnan(feats)):
                X.append(feats)
                y.append(act)
                subjects.append(subj)
    X = np.array(X)
    y = np.array(y)
    subjects = np.array(subjects)
    print(f"Extracted {len(X)} windows ({X.shape[1]} features each)")
    return X, y, subjects


def main():
    print("Loading data...")
    data = load_data()

    print("Extracting features...")
    X, y, subjects = build_features(data)

    # Subject-based split: 1-19 train, 20-24 test
    train_mask = subjects <= 19
    test_mask = subjects > 19
    X_train, y_train = X[train_mask], y[train_mask]
    X_test, y_test = X[test_mask], y[test_mask]
    print(f"Train: {len(X_train)} windows | Test: {len(X_test)} windows")

    print("Training Random Forest...")
    clf = RandomForestClassifier(n_estimators=200, random_state=42, n_jobs=-1)
    clf.fit(X_train, y_train)

    y_pred = clf.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"\nAccuracy: {acc:.4f}\n")
    print("Classification Report:")
    print(classification_report(y_test, y_pred))
    print("Confusion Matrix:")
    labels = sorted(set(y))
    print(f"Labels: {labels}")
    print(confusion_matrix(y_test, y_pred, labels=labels))

    joblib.dump(clf, MODEL_PATH)
    print(f"\nModel saved to {MODEL_PATH}")


if __name__ == "__main__":
    main()
