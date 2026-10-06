import { describe, expect, it } from 'vitest';
import { chartRangeChange, localAxisTicks } from './axis';

describe('local chart axis', () => {
  it('keeps repeated local hours in chronological order with distinct offsets', () => {
    const start = Date.parse('2026-11-01T05:30:00Z');
    const end = Date.parse('2026-11-01T06:30:00Z');
    const ticks = localAxisTicks([], [start, end], 'America/New_York');
    expect(Date.parse(ticks.tickvals[0]!)).toBe(start);
    expect(Date.parse(ticks.tickvals.at(-1)!)).toBe(end);
    expect(ticks.ticktext[0]).toContain('01:30 GMT-4');
    expect(ticks.ticktext.at(-1)).toContain('01:30 GMT-5');
    expect(ticks.tickvals.every((value, index) => index === 0 || value > ticks.tickvals[index - 1]!)).toBe(true);
  });

  it('skips invalid instants and renders a single observation at its actual instant', () => {
    const ticks = localAxisTicks(['invalid', '2026-10-06T10:15:00Z'], null, 'Asia/Kolkata');
    expect(ticks.tickvals).toEqual(['2026-10-06T10:15:00.000Z']);
    expect(ticks.ticktext[0]).toContain('15:45 GMT+5:30');
    expect(localAxisTicks([], null)).toEqual({ tickvals: [], ticktext: [] });
  });

  it.each([
    { 'xaxis.range': ['2026-11-01 05:30:00', '2026-11-01 06:30:00'] },
    { 'xaxis.range[0]': '2026-11-01T05:30:00Z', 'xaxis.range[1]': '2026-11-01T06:30:00Z' },
    { 'xaxis.range': [Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-01T06:30:00Z')] },
  ])('interprets Plotly ranges as absolute UTC coordinates', (event) => {
    expect(chartRangeChange(event)).toEqual([Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-01T06:30:00Z')]);
  });

  it('handles axis resets and ignores unrelated or malformed relayouts', () => {
    expect(chartRangeChange({ 'xaxis.autorange': true })).toBeNull();
    for (const event of [{ 'yaxis.range': [1, 2] }, { 'xaxis.range': [2, 1] }, { 'xaxis.range': ['invalid', '2026-01-01T10:00Z'] }]) {
      expect(chartRangeChange(event)).toBeUndefined();
    }
  });
});
