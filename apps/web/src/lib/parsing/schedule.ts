import { executeNextParse } from './executor';
import { PARSE_MAX_RUNNING } from './types';

interface ParseRuntime { timer: ReturnType<typeof setInterval>; controller: AbortController; active: number }
const shared = globalThis as typeof globalThis & { flightParseRuntime?: ParseRuntime };

/** User-requested parsing runs independently of automatic scrape preferences. */
export function startParseScheduler(): void {
  if (shared.flightParseRuntime) return;
  const controller = new AbortController();
  const tick = () => {
    if (controller.signal.aborted || runtime.active >= PARSE_MAX_RUNNING) return;
    runtime.active++;
    void executeNextParse(controller.signal).catch(() => {
      // Inputs, credentials and provider diagnostics stay outside routine logs.
      if (!controller.signal.aborted) console.error('[parse] Worker execution failed; inspect async parsing recovery');
    }).finally(() => { runtime.active--; });
  };
  const stop = () => {
    clearInterval(runtime.timer);
    controller.abort();
  };
  const runtime: ParseRuntime = { controller, active: 0, timer: setInterval(tick, 1000) };
  runtime.timer.unref();
  shared.flightParseRuntime = runtime;
  process.prependListener('SIGTERM', stop);
  process.prependListener('SIGINT', stop);
}
