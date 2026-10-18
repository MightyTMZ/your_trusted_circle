export interface SyntheticOffset {
  x: number;
  y: number;
}

/** returns a repeatable group path around the synthetic venue */
export function syntheticPosition(elapsedSec: number, participantIndex: number): SyntheticOffset {
  const phase = participantIndex * ((Math.PI * 2) / 3);
  const angle = elapsedSec / 13 + phase;
  const radius = 18 + 9 * (0.5 + 0.5 * Math.sin(elapsedSec / 21 + phase));
  const personal = {
    x: radius * Math.cos(angle) + 7 * Math.sin(elapsedSec / 7.5 + phase * 0.7),
    y: radius * Math.sin(angle) + 7 * Math.cos(elapsedSec / 9 + phase * 0.8),
  };

  if (participantIndex !== 1 && participantIndex !== 2) return personal;

  const meetup = Math.pow(Math.max(0, Math.sin(elapsedSec / 26 - 0.8)), 8);
  const meetupPoint = {
    x: 10 * Math.sin(elapsedSec / 21),
    y: 8 * Math.cos(elapsedSec / 24),
  };
  return {
    x: personal.x * (1 - meetup) + meetupPoint.x * meetup,
    y: personal.y * (1 - meetup) + meetupPoint.y * meetup,
  };
}
