import { describe, expect, it } from 'vitest';
import { parseCoordinates } from '../src/ui/venue';

describe('demo venue coordinates', () => {
  it('reads pasted coordinates and Google Maps links', () => {
    expect(parseCoordinates('43.6532, -79.3832')).toEqual({ lat: 43.6532, lng: -79.3832 });
    expect(parseCoordinates('https://www.google.com/maps/@43.6409,-79.3533,17z')).toEqual({ lat: 43.6409, lng: -79.3533 });
  });

  it('rejects addresses and impossible values', () => {
    expect(parseCoordinates('11 Polson St, Toronto')).toBeNull();
    expect(parseCoordinates('95, 10')).toBeNull();
    expect(parseCoordinates('Unit 5, 123 King St W')).toBeNull();
  });
});
