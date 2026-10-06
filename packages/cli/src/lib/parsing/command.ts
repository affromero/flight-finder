import type { Command } from 'commander';
import { parseCliFlight } from './runner.js';
import { ParseClientError } from '../../../../../apps/web/src/lib/parsing/client.js';

export function registerParseCommand(program: Command): () => boolean {
  let handled = false;
  program.command('parse <query>').description('Parse a flight request locally or on a server; synchronous by default')
    .option('--mode <mode>', 'sync or async', 'sync').option('--server <url>', 'Server origin; uses FLIGHT_FINDER_SESSION or FLIGHT_FINDER_TOKEN')
    .option('--json', 'Print machine-readable JSON')
    .action(async (...args: unknown[]) => {
      const query = args[0] as string;
      const command = args.at(-1) as Command;
      const options = command.optsWithGlobals<{ mode: string; server?: string; json?: boolean }>();
      handled = true;
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const mode = options.mode;
        if (mode !== 'sync' && mode !== 'async') throw new Error('--mode must be sync or async');
        const result = await parseCliFlight(query, undefined, { mode, server: options.server }, controller.signal);
        controller.signal.throwIfAborted();
        console.log(JSON.stringify(result, null, options.json ? undefined : 2));
      } catch (error) {
        const message = error instanceof ParseClientError && error.code === 'cancellation_unconfirmed'
          ? 'Could not confirm cancellation. The server job may still be running.'
          : controller.signal.aborted ? 'Parsing cancelled.' : error instanceof ParseClientError ? `Background parsing stopped: ${error.code}` : error instanceof Error ? error.message : 'Parse failed';
        console.error(options.json ? JSON.stringify({ error: message }) : `Error: ${message}`);
        process.exitCode = controller.signal.aborted ? 130 : 1;
      } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        if (!options.server) { const { prisma } = await import('@/lib/prisma'); await prisma.$disconnect(); }
      }
    });
  return () => handled;
}
