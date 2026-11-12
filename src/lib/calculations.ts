export interface EnergyReading {
  kwh: number;
}

export interface EnergySummary {
  totalKwh: number;
  estimatedCost: number;
  averageDailyKwh: number;
}

export function calculateEnergySummary(
  readings: readonly EnergyReading[],
  ratePerKwh: number,
  dayCount: number,
): EnergySummary {
  if (!Number.isFinite(ratePerKwh) || ratePerKwh < 0) throw new RangeError("Rate must be a non-negative number.");
  if (!Number.isInteger(dayCount) || dayCount <= 0) throw new RangeError("Day count must be a positive integer.");
  const totalKwh = readings.reduce((total, reading) => {
    if (!Number.isFinite(reading.kwh) || reading.kwh < 0) throw new RangeError("Reading values must be non-negative numbers.");
    return total + reading.kwh;
  }, 0);
  return {
    totalKwh,
    estimatedCost: Math.round(totalKwh * ratePerKwh * 100) / 100,
    averageDailyKwh: totalKwh / dayCount,
  };
}

export function calculatePercentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current < 0 || previous < 0) {
    throw new RangeError("Comparison values must be non-negative numbers.");
  }
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}
