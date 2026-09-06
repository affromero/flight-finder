import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { HotelClient } from './hotel-client.js';
import type { HotelSearch } from '../../../../apps/web/src/lib/hotels/types.js';

interface Options { server?: string; json?: boolean; file?: string; query?: string; wait?: boolean; timeout?: string; mode?: string; target?: string; lows?: boolean; approximate?: boolean; interval?: string }

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

function output(value: unknown, json?: boolean) {
  if (json) { console.log(JSON.stringify(value)); return; }
  console.log(JSON.stringify(value, null, 2));
}

async function readSearchFile(path: string): Promise<HotelSearch> {
  if (path !== '-') return JSON.parse(await readFile(path, 'utf8')) as HotelSearch;
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return JSON.parse(text) as HotelSearch;
}

export function registerHotelCommands(program: Command): () => boolean {
  let handled = false;
  const hotels = program.command('hotels').description('Search and track hotels on your self-hosted server; flight configuration is unchanged')
    .option('--server <url>', 'Self-hosted server URL (or FLIGHT_FINDER_URL)')
    .option('--json', 'Print machine-readable JSON');
  hotels.command('browse').description('Interactive hotel tracker list and price history').action(async () => {
    handled = true;
    if (!process.stdin.isTTY) throw new Error('Hotel browser needs a terminal; use hotels list --json in scripts');
    const [{ render }, { createElement }, { HotelBrowser }] = await Promise.all([import('ink'), import('react'), import('../screens/HotelBrowser.js')]);
    const instance = render(createElement(HotelBrowser, { server: hotels.opts<Options>().server ?? process.env.FLIGHT_FINDER_URL ?? 'http://localhost:3003' }));
    await instance.waitUntilExit();
  });
  const action = (command: Command, run: (client: HotelClient, context: { options: Options; args: string[] }) => Promise<unknown>) => {
    command.action(async (...args: unknown[]) => {
      handled = true;
      const invoked = args.at(-1) as Command;
      const options = invoked.optsWithGlobals<Options>();
      try {
        const client = new HotelClient(options.server ?? process.env.FLIGHT_FINDER_URL ?? `http://localhost:${process.env.HOST_PORT ?? process.env.PORT ?? '3003'}`, process.env.FLIGHT_FINDER_SESSION, process.env.FLIGHT_FINDER_TOKEN);
        output(await run(client, { options, args: args.filter((arg): arg is string => typeof arg === 'string') }), options.json);
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(options.json ? JSON.stringify({ error: message }) : `Error: ${message}`);
        process.exitCode = 1;
      }
    });
  };
  action(hotels.command('search').description('Search using a full HotelSearch JSON file or natural language')
    .option('--file <path>', 'Structured HotelSearch JSON file').option('--query <text>', 'Natural language hotel request').option('--wait', 'Wait for completion; Ctrl-C cancels the server search')
    .option('--timeout <minutes>', 'Maximum wait before cancelling the server search', '120'),
  async (client, { options }) => {
    if (Boolean(options.file) === Boolean(options.query)) throw new Error('Supply exactly one of --file or --query');
    const timeout = numberOption(options.timeout, '--timeout')!;
    if (!Number.isFinite(timeout * 60_000)) throw new Error('--timeout is too large');
    const search = options.file ? await readSearchFile(options.file)
      : (await client.request<{ search: HotelSearch }>('/api/hotels/parse', 'POST', { text: options.query })).search;
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error('Hotel search cancelled'));
    process.once('SIGINT', cancel);
    try { return await client.search(search, { wait: options.wait, signal: abort.signal, timeoutMs: timeout * 60_000 }); }
    finally { process.removeListener('SIGINT', cancel); }
  });
  action(hotels.command('results <searchId>').description('Read search status, offers, and provider errors'), (client, { args: [id] }) => client.request(`/api/hotels/search/${encodeURIComponent(id!)}`));
  action(hotels.command('cancel <searchId>').description('Cancel a running search'), (client, { args: [id] }) => client.request(`/api/hotels/search/${encodeURIComponent(id!)}`, 'DELETE'));
  action(hotels.command('track <searchId> <offerId>').description('Save a returned offer as a hotel tracker')
    .option('--mode <mode>', 'best qualifying offer or specific room: best, room', 'best')
    .option('--target <amount>', 'Alert at or below total-stay amount').option('--no-lows', 'Disable historical-low alerts')
    .option('--approximate', 'Allow alerts on approximate room matches').option('--interval <hours>', 'Check interval in hours', '3'),
  (client, { options, args: [searchId, offerId] }) => {
    if (!['best', 'room'].includes(options.mode!)) throw new Error('--mode must be best or room');
    return client.request('/api/hotels', 'POST', { searchId, offerId, mode: options.mode, targetPrice: numberOption(options.target, '--target') ?? null,
      notifyLows: options.lows !== false, allowApproximateAlerts: Boolean(options.approximate), scrapeInterval: numberOption(options.interval, '--interval') });
  });
  action(hotels.command('list').description('List your hotel trackers'), (client) => client.request('/api/hotels'));
  for (const name of ['view', 'history'] as const) action(hotels.command(`${name} <id>`).description('Read tracker, price history, check errors, and notification readiness'),
    (client, { args: [id] }) => client.request(`/api/hotels/${encodeURIComponent(id!)}`));
  for (const name of ['pause', 'resume', 'delete', 'refresh'] as const) action(hotels.command(`${name} <id>`), (client, { args: [id] }) => {
    const path = `/api/hotels/${encodeURIComponent(id!)}`;
    if (name === 'delete') return client.request(path, 'DELETE');
    if (name === 'refresh') return client.request(`${path}/scrape`, 'POST');
    return client.request(path, 'PATCH', { active: name === 'resume' });
  });
  action(hotels.command('alerts <id>').description('Update alerts; use --clear-target to remove a target')
    .option('--target <amount>').option('--clear-target').option('--lows').option('--no-lows')
    .option('--approximate').option('--no-approximate').option('--interval <hours>'),
  (client, { options, args: [id] }) => {
    const clear = (options as Options & { clearTarget?: boolean }).clearTarget;
    if (clear && options.target) throw new Error('Choose --target or --clear-target');
    const changes = { targetPrice: clear ? null : numberOption(options.target, '--target'), notifyLows: options.lows,
      allowApproximateAlerts: options.approximate, scrapeInterval: numberOption(options.interval, '--interval') };
    if (Object.values(changes).every((value) => value === undefined)) throw new Error('Supply at least one alert setting');
    return client.request(`/api/hotels/${encodeURIComponent(id!)}`, 'PATCH', changes);
  });
  hotels.action(() => { handled = true; hotels.outputHelp(); });
  return () => handled;
}
