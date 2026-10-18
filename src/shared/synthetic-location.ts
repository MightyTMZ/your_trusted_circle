export interface SyntheticOffset {
  x: number;
  y: number;
}

/** returns a repeatable walking path around the synthetic venue */
export function syntheticPosition(elapsedSec: number, participantIndex: number): SyntheticOffset {
  const phase = participantIndex * ((Math.PI * 2) / 3);
  return {
    x: 26 * Math.sin(elapsedSec / 15 + phase) + 9 * Math.sin(elapsedSec / 6.5 + phase * 0.7),
    y: 22 * Math.cos(elapsedSec / 18 + phase) + 8 * Math.cos(elapsedSec / 8.5 + phase * 0.8),
  };
}
