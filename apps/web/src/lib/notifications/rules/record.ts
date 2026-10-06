import { createHash } from 'node:crypto';
import type { Prisma, Query } from '@/generated/prisma/client';
import { formatCurrency } from '@/lib/currency';
import { safeHttpUrl } from '@/lib/safe-url';
import type { NotificationRouting } from '../subscriptions/authority';
import { criteriaVersion } from '../authority/flight';
import { ruleCollection } from './store';
import { ruleFare, ruleObservations } from './observations';
import { evaluatePriceRule } from './evaluate';
import type { PriceEventAuthority } from './authority';

/** Rule state and its durable event share the price-observation transaction. */
export async function recordPriceRuleAlerts(tx: Prisma.TransactionClient, query: Query, cycleStartedAt: Date,
  routing: NotificationRouting, baselineFrom: Date | null, baseUrl: string | null): Promise<{ custom: boolean; revision: number }> {
  const collection = await ruleCollection(tx, query.id);
  const rules = collection.rules.filter(rule => rule.enabled);
  if (!rules.length) return { custom: false, revision: collection.revision };
  const observations = await ruleObservations(tx, query, baselineFrom);
  const version = criteriaVersion(query), now = new Date();
  for (const rule of rules) {
    if (query.currency && query.currency !== rule.currency) continue;
    const fare = ruleFare(observations, rule, cycleStartedAt);
    if (!fare) continue;
    const state = rule.criteriaVersion === version ? rule : { baselinePrice: null, lastNotifiedPrice: null, lastNotifiedAt: null };
    const evaluated = evaluatePriceRule(rule, state, fare.price, now);
    const data = { ...evaluated.state, criteriaVersion: version };
    if (!evaluated.triggered) {
      await tx.queryAlertRule.update({ where: { id: rule.id }, data });
      continue;
    }
    if (rule.eventSequence >= 2147483647) throw new Error('Price alert event sequence exhausted');
    const sequence = rule.eventSequence + 1;
    const authority: PriceEventAuthority = { kind: 'price-rule', collectionRevision: collection.revision, ruleId: rule.id, ruleRevision: rule.revision, sequence };
    const key = createHash('sha256').update(JSON.stringify([query.id, query.userId, version, authority, routing])).digest('hex');
    const reasons: string[] = [];
    if (evaluated.target) reasons.push(`at or below your target of ${formatCurrency(rule.targetPrice, rule.currency)}`);
    if (evaluated.absolute) reasons.push(`dropped by at least ${formatCurrency(rule.dropAbs, rule.currency)}`);
    if (evaluated.percentage) reasons.push(`dropped by at least ${(rule.dropPct! * 100).toLocaleString('en-US')}%`);
    const bookingUrl = safeHttpUrl(fare.bookingUrl);
    const message = { title: `Price alert: ${query.origin} to ${query.destination} ${formatCurrency(fare.price, rule.currency)}`,
      body: `${fare.airline} on ${fare.travelDate}: ${reasons.join(' or ')}.`,
      url: baseUrl ? `${baseUrl.replace(/\/+$/, '')}/q/${query.id}` : bookingUrl,
      priceAuthority: authority, notificationRouting: routing,
      data: { queryId: query.id, userId: query.userId, queryVersion: version, currentMin: fare.price, currency: rule.currency, ruleId: rule.id, bookingUrl } };
    await tx.travelAlertDelivery.upsert({ where: { eventKey: `flight-rule:${key}` }, update: {}, create: {
      queryId: query.id, eventKey: `flight-rule:${key}`, message: JSON.parse(JSON.stringify(message)),
    } });
    await tx.queryAlertRule.update({ where: { id: rule.id }, data: { ...data, eventSequence: sequence } });
  }
  return { custom: true, revision: collection.revision };
}
