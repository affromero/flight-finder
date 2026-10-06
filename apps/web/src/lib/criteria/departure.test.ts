import { describe, expect, it } from 'vitest';
import { departureClockMinutes, departureCriteriaError, matchesDepartureWindow } from './departure';

describe('airport-local departure windows', () => {
  it.each([
    ['00:00', 0], ['0:00', 0], ['12:00 AM', 0], ['12:00 PM', 720],
    ['1:05 pm', 785], [' 23:59 ', 1439], ['10:00AM', 600],
  ])('reads the exact local clock %s', (value, expected) => {
    expect(departureClockMinutes(value)).toBe(expected);
  });

  it.each([null, undefined, '', '24:00', '12:60', '00:00 AM', '13:00 PM', '9:5', '9 AM',
    '09:00 UTC', '09:00 +0100', '2026-11-01T09:00:00', '09:00 / 21:00', '-1:00'])(
    'rejects an unknown or ambiguous local clock %s', (value) => {
      expect(departureClockMinutes(value)).toBeNull();
    });

  it.each([
    ['morning', '00:00', true], ['morning', '11:59', true], ['morning', '12:00', false],
    ['afternoon', '11:59', false], ['afternoon', '12:00 PM', true], ['afternoon', '18:00', true],
    ['afternoon', '18:01', false], ['evening', '18:00', false], ['evening', '18:01', true],
    ['evening', '23:59', true], ['redeye', '21:59', false], ['redeye', '10:00 PM', true],
    ['redeye', '23:59', true], ['redeye', '00:00', false],
  ])('applies the %s boundary at %s', (preference, time, expected) => {
    expect(matchesDepartureWindow(time, preference)).toBe(expected);
  });

  it('keeps unknown clocks in an unrestricted window and excludes them in named windows', () => {
    expect(matchesDepartureWindow(null, 'any')).toBe(true);
    expect(matchesDepartureWindow(null, 'morning')).toBe(false);
    expect(matchesDepartureWindow('09:00', 'unrecognized')).toBe(false);
  });

  it('requires explicit boolean strictness and a valid named window', () => {
    expect(departureCriteriaError(undefined, undefined)).toBeNull();
    expect(departureCriteriaError('any', false)).toBeNull();
    expect(departureCriteriaError('morning', true)).toBeNull();
    expect(departureCriteriaError('morning', 'false')).toContain('boolean');
    expect(departureCriteriaError('any', true)).toContain('named');
    expect(departureCriteriaError(undefined, true)).toContain('named');
    expect(departureCriteriaError('invalid', false)).toContain('timePreference');
  });
});
