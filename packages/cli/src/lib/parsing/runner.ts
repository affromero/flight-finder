import type { ParseResponse } from '../../../../../apps/web/src/lib/scraper/parse-query.js';
import { readParseInput, type ParseMessage } from '../../../../../apps/web/src/lib/parsing/input.js';
import type { ParseJobStatus } from '../../../../../apps/web/src/lib/parsing/types.js';

export interface ParseMode { mode: 'sync' | 'async'; server?: string }

export async function parseCliFlight(query: string, history: ParseMessage[] | undefined, options: ParseMode, signal: AbortSignal, onJob: (job: ParseJobStatus | null) => void = () => {}): Promise<ParseResponse> {
  if (!options.server && options.mode === 'sync') {
    const { parseFlightQuery } = await import('../../../../../apps/web/src/lib/scraper/parse-query.js');
    return (await parseFlightQuery(query, history, { signal })).response;
  }
  const input = readParseInput({ query, conversationHistory: history });
  if (options.server) {
    const { parseOnServer } = await import('./server.js');
    return parseOnServer(input, options.mode === 'async', options.server, signal, onJob);
  }
  const { parseLocally } = await import('./local.js');
  return parseLocally(input, signal, onJob);
}
