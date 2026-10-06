import { randomUUID } from 'node:crypto';
import type { Prisma, Query, QueryAlertRule } from '@/generated/prisma/client';
import { authorizeMutation } from '@/lib/query-auth';
import { notificationTransaction } from '../database';
import { lockNotificationQuery } from '../subscriptions/authority';
import { criteriaVersion, notificationBaselineFrom } from '../authority/flight';
import { parsePriceRules, PriceRuleError, type RuleInput } from './config';
import { ruleObservations, ruleFare, ruleFlightChoices } from './observations';

function ruleConfig(rule: RuleInput | QueryAlertRule): RuleInput {
  return { ...(rule.id ? { id: rule.id } : {}), flightId: rule.flightId, currency: rule.currency, targetPrice: rule.targetPrice,
    dropAbs: rule.dropAbs, dropPct: rule.dropPct, enabled: rule.enabled, cooldownMinutes: rule.cooldownMinutes };
}

export async function ruleCollection(tx: Prisma.TransactionClient, queryId: string) {
  const settings = await tx.queryAlertSettings.findUnique({ where: { queryId } });
  const rules = await tx.queryAlertRule.findMany({ where: { queryId }, orderBy: { id: 'asc' } });
  return { revision: settings?.revision ?? 0, rules };
}

async function authorized(tx: Prisma.TransactionClient, queryId: string, token: string | null) {
  const query = await lockNotificationQuery(tx, queryId);
  if (!query) throw new PriceRuleError('Tracker not found', 404);
  const auth = await authorizeMutation(query, token);
  if (!auth.ok) throw new PriceRuleError(auth.error ?? 'Forbidden', auth.status ?? 403);
  return query;
}

async function settings(tx: Prisma.TransactionClient, query: Query) {
  const collection = await ruleCollection(tx, query.id);
  const observations = await ruleObservations(tx, query, await notificationBaselineFrom(tx, query));
  return { revision: collection.revision, rules: collection.rules.map(ruleConfig), flights: ruleFlightChoices(observations),
    currency: observations.comparisonCurrency };
}

export async function readPriceRules(queryId: string, token: string | null) {
  return notificationTransaction(async tx => settings(tx, await authorized(tx, queryId, token)));
}

export async function updatePriceRules(queryId: string, token: string | null, raw: unknown) {
  const input = parsePriceRules(raw);
  return notificationTransaction(async tx => {
    const query = await authorized(tx, queryId, token);
    const current = await ruleCollection(tx, queryId);
    if (current.revision !== input.revision) throw new PriceRuleError('Price rules changed. Reload before saving.', 409);
    if (input.rules.some(rule => rule.id && !current.rules.some(existing => existing.id === rule.id))) throw new PriceRuleError('Unavailable price rule ID', 400);
    if (query.currency && input.rules.some(rule => rule.currency !== query.currency)) throw new PriceRuleError('Price rules must use the tracker currency', 400);
    const original = current.rules.map(ruleConfig).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const desired = [...input.rules].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (JSON.stringify(original) === JSON.stringify(desired)) return settings(tx, query);
    if (current.revision >= 2147483647) throw new PriceRuleError('Price rule revision exhausted', 409);
    const observations = await ruleObservations(tx, query, await notificationBaselineFrom(tx, query));
    for (const inputRule of input.rules) {
      const previous = current.rules.find(rule => rule.id === inputRule.id);
      const changed = !previous || JSON.stringify(ruleConfig(previous)) !== JSON.stringify(inputRule);
      if (!changed) continue;
      const changedScope = !previous || previous.flightId !== inputRule.flightId || previous.currency !== inputRule.currency;
      if (changedScope && inputRule.flightId && !ruleFlightChoices(observations).some(flight => flight.id === inputRule.flightId && flight.currency === inputRule.currency)) {
        throw new PriceRuleError('Choose an available identifiable flight in this currency', 400);
      }
      const id = inputRule.id ?? randomUUID();
      const revision = (previous?.revision ?? 0) + 1;
      if (revision > 2147483647) throw new PriceRuleError('Price rule revision exhausted', 409);
      const data = { ...ruleConfig(inputRule), id, queryId, revision, criteriaVersion: criteriaVersion(query),
        baselinePrice: inputRule.dropAbs !== null || inputRule.dropPct !== null ? ruleFare(observations, inputRule)?.price ?? null : null,
        lastNotifiedPrice: null, lastNotifiedAt: null };
      await tx.queryAlertRule.upsert({ where: { id }, create: data, update: data });
    }
    await tx.queryAlertRule.deleteMany({ where: { queryId, id: { in: current.rules.filter(rule => !input.rules.some(input => input.id === rule.id)).map(rule => rule.id) } } });
    await tx.queryAlertSettings.upsert({ where: { queryId }, create: { queryId, revision: current.revision + 1 }, update: { revision: current.revision + 1 } });
    return settings(tx, query);
  });
}
