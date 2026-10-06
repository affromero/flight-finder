import type { RuleConditions } from './evaluate';

export class PriceRuleError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface RuleInput extends RuleConditions {
  id?: string;
  flightId: string | null;
  currency: string;
  enabled: boolean;
}

function threshold(raw: unknown, field: string, max = 1e12): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > max) throw new PriceRuleError(`Invalid ${field}`, 400);
  return raw;
}

export function parsePriceRules(raw: unknown): { revision: number; rules: RuleInput[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PriceRuleError('Invalid price rules', 400);
  const body = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0 || !Array.isArray(body.rules) || body.rules.length > 20
    || Object.keys(body).some(key => !['revision', 'rules', 'deleteToken'].includes(key))) throw new PriceRuleError('Invalid price rules', 400);
  const rules = body.rules.map((raw: unknown): RuleInput => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PriceRuleError('Invalid price rule', 400);
    const rule = raw as Record<string, unknown>;
    if (Object.keys(rule).some(key => !['id', 'flightId', 'currency', 'targetPrice', 'dropAbs', 'dropPct', 'enabled', 'cooldownMinutes'].includes(key))
      || rule.id !== undefined && (typeof rule.id !== 'string' || !rule.id || rule.id.length > 200)
      || rule.flightId !== null && rule.flightId !== undefined && (typeof rule.flightId !== 'string' || !rule.flightId || rule.flightId.length > 300)
      || typeof rule.currency !== 'string' || !/^[A-Z]{3}$/.test(rule.currency)
      || rule.enabled !== undefined && typeof rule.enabled !== 'boolean') throw new PriceRuleError('Invalid price rule', 400);
    const targetPrice = threshold(rule.targetPrice, 'target price'), dropAbs = threshold(rule.dropAbs, 'absolute drop'), dropPct = threshold(rule.dropPct, 'drop fraction', 1);
    if (dropPct === 1 || targetPrice === null && dropAbs === null && dropPct === null) throw new PriceRuleError('Set a target or drop threshold below 100 percent', 400);
    const cooldownMinutes = rule.cooldownMinutes ?? 0;
    if (!Number.isSafeInteger(cooldownMinutes) || Number(cooldownMinutes) < 0 || Number(cooldownMinutes) > 10080) throw new PriceRuleError('Invalid cooldown minutes', 400);
    return { ...(rule.id === undefined ? {} : { id: String(rule.id) }), flightId: typeof rule.flightId === 'string' ? rule.flightId : null,
      currency: rule.currency, targetPrice, dropAbs, dropPct, enabled: rule.enabled !== false, cooldownMinutes: Number(cooldownMinutes) };
  });
  const ids = rules.flatMap(rule => rule.id ? [rule.id] : []);
  if (new Set(ids).size !== ids.length) throw new PriceRuleError('Duplicate price rule IDs', 400);
  return { revision: Number(body.revision), rules };
}
