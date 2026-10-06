import { parseCliFlight, type ParseMode } from './runner.js';
import type { ParseMessage } from '../../../../../apps/web/src/lib/parsing/input.js';
import type { ParseJobStatus } from '../../../../../apps/web/src/lib/parsing/types.js';
import type { ParseResponse } from '../../../../../apps/web/src/lib/scraper/parse-query.js';
import { ParseClientError } from '../../../../../apps/web/src/lib/parsing/client.js';

/** One interactive session owns its tasks until cancellation has settled. */
export class CliParseSession {
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<ParseResponse>>();
  constructor(private readonly options: ParseMode = { mode: 'async' }) {}

  run(query: string, history: ParseMessage[] | undefined, signal: AbortSignal, onJob: (job: ParseJobStatus | null) => void): Promise<ParseResponse> {
    const task = parseCliFlight(query, history, this.options, AbortSignal.any([signal, this.controller.signal]), onJob);
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }

  async stop(): Promise<void> {
    this.controller.abort();
    const results = await Promise.allSettled([...this.tasks]);
    const uncertain = results.find(result => result.status === 'rejected' && result.reason instanceof ParseClientError && result.reason.code === 'cancellation_unconfirmed');
    if (uncertain?.status === 'rejected') throw uncertain.reason;
  }
}
