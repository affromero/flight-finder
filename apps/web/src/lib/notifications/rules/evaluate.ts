export interface RuleConditions {
  targetPrice: number | null;
  dropAbs: number | null;
  /** Fraction, such as 0.1 for ten percent. */
  dropPct: number | null;
  cooldownMinutes: number;
}

export interface RuleState {
  baselinePrice: number | null;
  lastNotifiedPrice: number | null;
  lastNotifiedAt: Date | null;
}

const EPS = 0.005;

/** Advance this result only in the transaction that persists the durable event. */
export function evaluatePriceRule(rule: RuleConditions, state: RuleState, price: number, now: Date) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('A price alert needs a positive finite fare');
  const baseline = state.baselinePrice ?? price;
  const drop = Math.round((baseline - price) * 100) / 100;
  const target = rule.targetPrice !== null && price <= rule.targetPrice + EPS;
  const absolute = drop > 0 && rule.dropAbs !== null && drop >= rule.dropAbs - EPS;
  const percentage = drop > 0 && rule.dropPct !== null && drop / baseline >= rule.dropPct - 1e-9;
  const needsBaseline = rule.dropAbs !== null || rule.dropPct !== null;
  const next: RuleState = { ...state, baselinePrice: needsBaseline ? baseline : null };
  const aboveTarget = rule.targetPrice === null || price > rule.targetPrice + EPS;
  if (!target && !absolute && !percentage) {
    if (aboveTarget && (!needsBaseline || price >= baseline - EPS)) next.lastNotifiedPrice = null;
    return { triggered: false, target, absolute, percentage, state: next };
  }
  const coolingDown = state.lastNotifiedAt !== null && now.getTime() < state.lastNotifiedAt.getTime() + rule.cooldownMinutes * 60_000;
  if (coolingDown || state.lastNotifiedPrice !== null && price >= state.lastNotifiedPrice - EPS) {
    return { triggered: false, target, absolute, percentage, state: next };
  }
  return { triggered: true, target, absolute, percentage,
    state: { baselinePrice: absolute || percentage ? price : next.baselinePrice, lastNotifiedPrice: price, lastNotifiedAt: now } };
}
