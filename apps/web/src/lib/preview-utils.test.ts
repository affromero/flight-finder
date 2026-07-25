import { describe, it, expect } from 'vitest';
import {
  GoogleFlightsLoadingShellError,
  isGoogleFlightsLoadingShell,
} from './preview-utils';

describe('isGoogleFlightsLoadingShell', () => {
  it('returns true for a short loading shell with no prices', () => {
    expect(isGoogleFlightsLoadingShell('Loading results…')).toBe(true);
  });

  it('returns false when resultsFound is true', () => {
    expect(isGoogleFlightsLoadingShell('Loading results…', true)).toBe(false);
  });

  it('returns false when price tokens appear in the head', () => {
    expect(isGoogleFlightsLoadingShell('Loading results… from $499 round trip')).toBe(false);
  });

  it('recognizes price signals from non-Western currencies', () => {
    expect(isGoogleFlightsLoadingShell('Loading results… from ¥49,900 round trip')).toBe(false);
    expect(isGoogleFlightsLoadingShell('Loading results… from 4 990 NOK round trip')).toBe(false);
  });

  it('returns true for long chrome that only mentions Loading results', () => {
    const chrome = `${'x'.repeat(3500)}Loading results${'y'.repeat(500)}`;
    expect(isGoogleFlightsLoadingShell(chrome)).toBe(true);
  });
});

describe('GoogleFlightsLoadingShellError', () => {
  it('sets routeKey from origin and destination', () => {
    const error = new GoogleFlightsLoadingShellError('LAX', 'YOW');
    expect(error.routeKey).toBe('LAX-YOW');
    expect(error.name).toBe('GoogleFlightsLoadingShellError');
  });
});
