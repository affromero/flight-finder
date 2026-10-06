import { describe, expect, it } from 'vitest';
import { evaluatePriceRule } from './evaluate';
import { parsePriceRules } from './config';

const now = new Date('2026-10-06T12:00:00Z');
const empty = { baselinePrice: null, lastNotifiedPrice: null, lastNotifiedAt: null };
const conditions = { targetPrice: null, dropAbs: 20, dropPct: null, cooldownMinutes: 0 };

describe('price alert conditions', () => {
  it('establishes a missing drop baseline without treating the first observation as a drop', () => {
    expect(evaluatePriceRule(conditions, empty, 100, now)).toMatchObject({ triggered: false, state: { baselinePrice: 100 } });
  });
  it('allows a target to fire on the first observation', () => {
    expect(evaluatePriceRule({ ...conditions, targetPrice: 100 }, empty, 100, now)).toMatchObject({ triggered: true, target: true });
  });
  it('combines target, absolute and percentage conditions with OR semantics', () => {
    const state = { ...empty, baselinePrice: 200 };
    const rule = { ...conditions, targetPrice: 50, dropAbs: 100, dropPct: 0.1 };
    expect(evaluatePriceRule(rule, state, 180, now)).toMatchObject({ triggered: true, target: false, absolute: false, percentage: true });
  });
  it('rearms a drop from the durable alert price and suppresses a steady or smaller subsequent drop', () => {
    const first = evaluatePriceRule(conditions, { ...empty, baselinePrice: 200 }, 180, now);
    expect(first).toMatchObject({ triggered: true, state: { baselinePrice: 180, lastNotifiedPrice: 180 } });
    expect(evaluatePriceRule(conditions, first.state, 180, now).triggered).toBe(false);
    expect(evaluatePriceRule(conditions, first.state, 170, now).triggered).toBe(false);
    expect(evaluatePriceRule(conditions, first.state, 160, now).triggered).toBe(true);
  });
  it('allows a fresh target entry after a recovery above the target and baseline', () => {
    const rule = { ...conditions, targetPrice: 100, dropAbs: null };
    const first = evaluatePriceRule(rule, { ...empty, baselinePrice: 100 }, 90, now);
    expect(evaluatePriceRule(rule, first.state, 90, now).triggered).toBe(false);
    const recovered = evaluatePriceRule(rule, first.state, 110, now);
    expect(recovered.state.lastNotifiedPrice).toBeNull();
    expect(evaluatePriceRule(rule, recovered.state, 95, now).triggered).toBe(true);
  });
  it('rearms a target-only rule above its target even when the creation fare was much higher', () => {
    const rule = { ...conditions, targetPrice: 100, dropAbs: null };
    const created = evaluatePriceRule(rule, { ...empty, baselinePrice: 200 }, 200, now);
    const first = evaluatePriceRule(rule, created.state, 90, now);
    expect(first.triggered).toBe(true);
    const recovered = evaluatePriceRule(rule, first.state, 110, now);
    expect(evaluatePriceRule(rule, recovered.state, 95, now).triggered).toBe(true);
  });
  it('retains a threshold during cooldown and fires when the cooldown boundary arrives', () => {
    const rule = { ...conditions, cooldownMinutes: 10 };
    const state = { baselinePrice: 200, lastNotifiedPrice: 200, lastNotifiedAt: now };
    const waiting = evaluatePriceRule(rule, state, 180, new Date(now.getTime() + 599999));
    expect(waiting).toMatchObject({ triggered: false, state });
    expect(evaluatePriceRule(rule, waiting.state, 180, new Date(now.getTime() + 600000)).triggered).toBe(true);
  });
  it('handles a cent boundary without floating point drift', () => {
    expect(evaluatePriceRule({ ...conditions, dropAbs: 0.2 }, { ...empty, baselinePrice: 100.1 }, 99.9, now).triggered).toBe(true);
  });
  it('requires a real decrease even when a drop threshold is smaller than numeric tolerance', () => {
    const rule = { ...conditions, dropAbs: 0.001, dropPct: 1e-10 };
    const first = evaluatePriceRule(rule, empty, 100, now);
    expect(first.triggered).toBe(false);
    expect(evaluatePriceRule(rule, first.state, 100, now).triggered).toBe(false);
    expect(evaluatePriceRule(rule, first.state, 100.01, now).triggered).toBe(false);
    expect(evaluatePriceRule(rule, first.state, 99.99, now).triggered).toBe(true);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid observed fare %s', price => {
    expect(() => evaluatePriceRule(conditions, empty, price, now)).toThrow(/finite fare/);
  });
});

describe('price rule input', () => {
  const rule = { currency: 'USD', targetPrice: 100 };
  it('uses a fractional percentage and explicit currency with normalized defaults', () => {
    expect(parsePriceRules({ revision: 0, rules: [{ ...rule, dropPct: 0.1 }] })).toEqual({ revision: 0, rules: [
      { ...rule, dropPct: 0.1, dropAbs: null, flightId: null, enabled: true, cooldownMinutes: 0 },
    ] });
  });
  it.each([{ targetPrice: '100' }, { targetPrice: Number.NaN }, { targetPrice: -1 }, { currency: 'usd' }, { dropPct: 10 },
    { dropPct: 1 }, { enabled: 'true' }, { cooldownMinutes: 0.5 }, { cooldownMinutes: 10081 }, { baselinePrice: 200 }])('rejects malformed or server-owned settings %j', changes => {
    expect(() => parsePriceRules({ revision: 0, rules: [{ ...rule, ...changes }] })).toThrow();
  });
  it('rejects rules without conditions, duplicate IDs and oversized collections', () => {
    expect(() => parsePriceRules({ revision: 0, rules: [{ currency: 'USD' }] })).toThrow();
    expect(() => parsePriceRules({ revision: 0, rules: [{ ...rule, id: 'same' }, { ...rule, id: 'same' }] })).toThrow(/Duplicate/);
    expect(() => parsePriceRules({ revision: 0, rules: Array.from({ length: 21 }, () => rule) })).toThrow();
  });
});
