import { describe, expect, it } from 'vitest';
import { filterSnapshotsByTrackerFilters } from './snapshot-filters';

const baseSnapshot = {
  price: 300,
  stops: 0,
  duration: '2h 30m',
  airline: 'Delta Air Lines',
};

describe('filterSnapshotsByTrackerFilters', () => {
  it('keeps snapshots at price and stop boundaries', () => {
    const snapshots = [
      { ...baseSnapshot, price: 500, stops: 1, airline: 'Delta' },
      { ...baseSnapshot, price: 501, stops: 1, airline: 'Delta' },
      { ...baseSnapshot, price: 500, stops: 2, airline: 'Delta' },
    ];

    const result = filterSnapshotsByTrackerFilters(snapshots, {
      maxPrice: 500,
      maxStops: 1,
      maxDurationHours: null,
      preferredAirlines: [],
    });

    expect(result).toEqual([snapshots[0]]);
  });

  it('filters parseable durations above the hour cap but keeps unknown durations', () => {
    const snapshots = [
      { ...baseSnapshot, duration: '3h 30m' },
      { ...baseSnapshot, duration: '4h 01m' },
      { ...baseSnapshot, duration: 'PT4H' },
    ];

    const result = filterSnapshotsByTrackerFilters(snapshots, {
      maxPrice: null,
      maxStops: null,
      maxDurationHours: 4,
      preferredAirlines: [],
    });

    expect(result).toEqual([snapshots[0], snapshots[2]]);
  });

  it('matches preferred airlines only against non-empty snapshot airline names', () => {
    const snapshots = [
      { ...baseSnapshot, airline: 'Delta Connection' },
      { ...baseSnapshot, airline: 'WestJet' },
      { ...baseSnapshot, airline: 'KLM Royal Dutch' },
      { ...baseSnapshot, airline: '' },
    ];

    const result = filterSnapshotsByTrackerFilters(snapshots, {
      maxPrice: null,
      maxStops: null,
      maxDurationHours: null,
      preferredAirlines: ['Delta', 'Jet', 'KLM'],
    });

    expect(result).toEqual([snapshots[0], snapshots[2]]);
  });

  it('does not reverse-match broad airline fragments', () => {
    const snapshots = [
      { ...baseSnapshot, airline: 'American' },
      { ...baseSnapshot, airline: 'American Airlines' },
    ];

    const result = filterSnapshotsByTrackerFilters(snapshots, {
      maxPrice: null,
      maxStops: null,
      maxDurationHours: null,
      preferredAirlines: ['American Airlines'],
    });

    expect(result).toEqual([snapshots[1]]);
  });
});
