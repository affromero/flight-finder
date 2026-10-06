export type ParseMessage = { role: 'user' | 'assistant'; content: string };
export interface ParseInput { query: string; conversationHistory?: ParseMessage[] }

/** Match the public request's defensive cap and the parser's effective prompt. */
function normalizeParseHistory(value: unknown): ParseMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 12).filter((entry): entry is { role: string; content: string } =>
    entry !== null && typeof entry === 'object'
    && typeof entry.role === 'string' && typeof entry.content === 'string',
  ).map(entry => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: entry.content }));
}

export function effectiveParseHistory(history?: ParseMessage[]): ParseMessage[] {
  return (history ?? []).slice(-6).map(entry => ({ ...entry, content: entry.content.slice(0, 2000) }));
}

export function readParseInput(value: unknown): ParseInput {
  if (!value || typeof value !== 'object' || !('query' in value) || typeof value.query !== 'string')
    throw new Error('Missing or invalid "query" field');
  const query = value.query.trim();
  if (query.length < 5 || query.length > 500) throw new Error('Query must be between 5 and 500 characters');
  const conversationHistory = normalizeParseHistory('conversationHistory' in value ? value.conversationHistory : undefined);
  return { query, ...(conversationHistory ? { conversationHistory } : {}) };
}
