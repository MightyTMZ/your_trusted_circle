import csv
import math

TIME = 0
LIN_ACCEL_X = 1
LIN_ACCEL_Y = 2
LIN_ACCEL_Z = 3
ABS_ACCEL = 4

COLUMNS = {
    LIN_ACCEL_X: "Linear Acceleration X (m/s^2)",
    LIN_ACCEL_Y: "Linear Acceleration Y (m/s^2)",
    LIN_ACCEL_Z: "Linear Acceleration Z (m/s^2)",
    ABS_ACCEL: "Absolute Acceleration (m/s^2)",
}

# Read data
data = {col: [] for col in COLUMNS}

with open('./data/Raw Data.csv', 'r') as file:
    reader = csv.reader(file)
    next(reader)  # Skip header
    for row in reader:
        for col in COLUMNS:
            data[col].append(float(row[col]))

count = len(data[LIN_ACCEL_X])

for col, name in COLUMNS.items():
    values = data[col]
    n = len(values)

    # Mean
    mean = sum(values) / n

    # Standard deviation (population)
    variance = sum((x - mean) ** 2 for x in values) / n
    std_dev = math.sqrt(variance)

    # Min / Max
    min_val = min(values)
    max_val = max(values)
    range_val = max_val - min_val

    # Median
    sorted_vals = sorted(values)
    if n % 2 == 1:
        median = sorted_vals[n // 2]
    else:
        median = (sorted_vals[n // 2 - 1] + sorted_vals[n // 2]) / 2

    # Q1 and Q3 (using linear interpolation)
    def percentile(sorted_data, p):
        k = (len(sorted_data) - 1) * p / 100
        f = math.floor(k)
        c = math.ceil(k)
        if f == c:
            return sorted_data[int(k)]
        return sorted_data[f] * (c - k) + sorted_data[c] * (k - f)

    q1 = percentile(sorted_vals, 25)
    q3 = percentile(sorted_vals, 75)
    iqr = q3 - q1

    # Skewness
    skewness = sum((x - mean) ** 3 for x in values) / (n * std_dev ** 3) if std_dev != 0 else 0

    # Kurtosis (excess)
    kurtosis = sum((x - mean) ** 4 for x in values) / (n * std_dev ** 4) - 3 if std_dev != 0 else 0

    # Root Mean Square
    rms = math.sqrt(sum(x ** 2 for x in values) / n)

    print(f"=== {name} ===")
    print(f"  Count:              {n}")
    print(f"  Mean:               {mean:.6f}")
    print(f"  Std Dev:            {std_dev:.6f}")
    print(f"  Min:                {min_val:.6f}")
    print(f"  Q1 (25th pct):      {q1:.6f}")
    print(f"  Median:             {median:.6f}")
    print(f"  Q3 (75th pct):      {q3:.6f}")
    print(f"  Max:                {max_val:.6f}")
    print(f"  Range:              {range_val:.6f}")
    print(f"  IQR:                {iqr:.6f}")
    print(f"  Skewness:           {skewness:.6f}")
    print(f"  Kurtosis (excess):  {kurtosis:.6f}")
    print(f"  RMS:                {rms:.6f}")
    print()
