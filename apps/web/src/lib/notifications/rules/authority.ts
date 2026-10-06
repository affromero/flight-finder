import type { Prisma } from '@/generated/prisma/client';
import { ruleCollection } from './store';

export type PriceEventAuthority = { kind: 'new-low'; collectionRevision: number }
  | { kind: 'price-rule'; collectionRevision: number; ruleId: string; ruleRevision: number; sequence: number };

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
}

/** Event keys fence malformed rule metadata from the legacy new-low decoder. */
export function decodePriceAuthority(eventKey: string, raw: unknown): PriceEventAuthority {
  if (eventKey.startsWith('flight:') && raw === undefined) return { kind: 'new-low', collectionRevision: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid price event authority');
  const value = raw as Record<string, unknown>;
  if (!revision(value.collectionRevision)) throw new Error('Invalid price event authority');
  if (value.kind === 'new-low' && eventKey.startsWith('flight:')) return { kind: value.kind, collectionRevision: value.collectionRevision };
  if (value.kind !== 'price-rule' || !eventKey.startsWith('flight-rule:') || typeof value.ruleId !== 'string' || !value.ruleId || value.ruleId.length > 200
    || !revision(value.ruleRevision) || value.ruleRevision === 0 || !revision(value.sequence) || value.sequence === 0) throw new Error('Invalid price event authority');
  return { kind: value.kind, collectionRevision: value.collectionRevision, ruleId: value.ruleId, ruleRevision: value.ruleRevision, sequence: value.sequence };
}

export async function assertPriceAuthority(tx: Prisma.TransactionClient, queryId: string, authority: PriceEventAuthority): Promise<void> {
  const collection = await ruleCollection(tx, queryId);
  if (collection.revision !== authority.collectionRevision) throw new Error('Price alert settings changed');
  if (authority.kind === 'new-low') {
    if (collection.rules.some(rule => rule.enabled)) throw new Error('Custom price rules supersede this low alert');
    return;
  }
  const rule = collection.rules.find(rule => rule.id === authority.ruleId);
  if (!rule?.enabled || rule.revision !== authority.ruleRevision || rule.eventSequence < authority.sequence) throw new Error('Price alert rule authority changed');
}
