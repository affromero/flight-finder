import { spawn } from 'node:child_process';
import { cliEnvironment } from './cli-environment';
import { isReasoningEffort, validModelId, type CliCatalog, type CliModel, type ReasoningSelection } from './cli-model-types';
import { CLI_PROVIDERS } from './provider-metadata';

const MAX_OUTPUT = 512_000;
const CACHE_MS = 60_000;
export class CliModelError extends Error {}
interface CommandResult { code: number | null; output: string }

function command(provider: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
  signal?.throwIfAborted();
  const env = cliEnvironment(provider);
  return new Promise((resolve, reject) => {
    const child = (() => {
      try { return spawn(CLI_PROVIDERS[provider]!, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
      catch { throw new CliModelError('CLI is not installed or could not start'); }
    })();
    let output = '', size = 0, failure: Error | undefined;
    const stop = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { stop(); reject(new CliModelError('CLI readiness check timed out')); }, 8000);
    const abort = () => { clearTimeout(timer); stop(); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const read = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { failure = new CliModelError('CLI response exceeded its size limit'); stop(); clearTimeout(timer); reject(failure); return; }
      output += chunk.toString();
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', () => { signal?.removeEventListener('abort', abort); clearTimeout(timer); reject(new CliModelError('CLI is not installed or could not start')); });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (exitSignal) reject(new CliModelError('CLI readiness check timed out'));
      else resolve({ code, output });
    });
  });
}

export async function probeCli(provider: string, signal?: AbortSignal): Promise<{ version: string; authenticated: boolean }> {
  if (!CLI_PROVIDERS[provider]) throw new CliModelError('Choose a supported CLI provider');
  const version = await command(provider, ['--version'], signal);
  const number = version.output.match(/\b\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*\b/)?.[0];
  if (version.code !== 0 || !number) throw new CliModelError('CLI version could not be verified');
  const auth = await command(provider, provider === 'codex' ? ['login', 'status'] : ['auth', 'status'], signal);
  return { version: number, authenticated: auth.code === 0 };
}

function codexModels(): Promise<CliModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { env: cliEnvironment('codex'), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', bytes = 0, requestId = 1, settled = false;
    const models: CliModel[] = [], cursors = new Set<string>();
    const timer = setTimeout(() => finish(new CliModelError('Codex model discovery timed out')), 15_000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdin.end(); child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
      kill.unref(); child.once('close', () => clearTimeout(kill));
      if (error) reject(error); else resolve(models);
    }
    function send(message: unknown) { if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`); }
    function page(cursor?: string) {
      send({ id: requestId, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    }
    function line(text: string) {
      let message: { id?: unknown; error?: unknown; result?: { data?: unknown; nextCursor?: unknown } };
      try { message = JSON.parse(text) as typeof message; }
      catch { finish(new CliModelError('Codex returned malformed model data')); return; }
      if (!message || typeof message !== 'object') { finish(new CliModelError('Codex returned malformed model data')); return; }
      if (message.id === 0) {
        if (message.error) { finish(new CliModelError('Codex initialization failed; check CLI authentication and version')); return; }
        send({ method: 'initialized', params: {} }); page(); return;
      }
      if (message.id !== requestId) return;
      if (message.error || !Array.isArray(message.result?.data)) { finish(new CliModelError('Codex model discovery failed; recheck authentication and CLI version')); return; }
      for (const raw of message.result.data as unknown[]) {
        if (!raw || typeof raw !== 'object') { finish(new CliModelError('Codex returned an invalid model')); return; }
        const entry = raw as Record<string, unknown>;
        if (entry.hidden === true) continue;
        const id = entry.model ?? entry.id;
        if (!validModelId(id) || !Array.isArray(entry.supportedReasoningEfforts) || !isReasoningEffort(entry.defaultReasoningEffort)) {
          finish(new CliModelError('Codex returned an invalid model capability')); return;
        }
        const efforts = entry.supportedReasoningEfforts.map((e: unknown) => e && typeof e === 'object' ? (e as Record<string, unknown>).reasoningEffort : null);
        if (!efforts.every(isReasoningEffort) || !efforts.includes(entry.defaultReasoningEffort)) { finish(new CliModelError('Codex returned invalid reasoning capabilities')); return; }
        if (models.some(model => model.id === id)) continue;
        models.push({ id, name: typeof entry.displayName === 'string' ? entry.displayName.slice(0, 128) : id,
          isDefault: entry.isDefault === true, defaultReasoningEffort: entry.defaultReasoningEffort, reasoningEfforts: [...new Set(efforts)] });
        if (models.length > 200) { finish(new CliModelError('Codex model catalog exceeded its size limit')); return; }
      }
      const cursor = message.result.nextCursor;
      if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || cursor.length > 1000)) { finish(new CliModelError('Codex returned an invalid page cursor')); return; }
      if (cursor) {
        if (cursors.has(cursor) || requestId >= 8) { finish(new CliModelError('Codex model pagination did not complete')); return; }
        cursors.add(cursor); requestId++; page(cursor); return;
      }
      finish(models.length ? undefined : new CliModelError('Codex returned no available models'));
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { finish(new CliModelError('Codex model output exceeded its size limit')); return; }
      buffer += chunk.toString(); let newline: number;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) { const text = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (text) line(text); }
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT) finish(new CliModelError('Codex model output exceeded its size limit')); });
    child.stdin.on('error', () => finish(new CliModelError('Codex model discovery disconnected')));
    child.on('error', () => finish(new CliModelError('Codex CLI could not start')));
    child.on('close', () => finish(new CliModelError('Codex exited before model discovery completed')));
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'flight-finder', version: '1.0.0' } } });
  });
}

const catalogCache = new Map<string, { until: number; value: Promise<CliCatalog> }>();
export function discoverCliModels(provider: string, refresh = false): Promise<CliCatalog> {
  if (!CLI_PROVIDERS[provider]) return Promise.reject(new CliModelError('Choose a supported CLI provider'));
  const cached = catalogCache.get(provider);
  if (cached && (!refresh || cached.until === Infinity) && cached.until > Date.now()) return cached.value;
  const value = (async () => {
    const probe = await probeCli(provider);
    if (!probe.authenticated) throw new CliModelError('CLI is installed but not signed in; authenticate it on the host and recheck');
    if (provider === 'codex') return { version: probe.version, models: await codexModels(), source: 'live' as const };
    return { version: probe.version, source: 'cli' as const, models: ['sonnet', 'opus'].map(id => ({ id, name: id === 'sonnet' ? 'Claude Sonnet' : 'Claude Opus', isDefault: id === 'sonnet', defaultReasoningEffort: null, reasoningEfforts: [] })) };
  })();
  const entry = { until: Infinity, value: value.then(value => { entry.until = Date.now() + CACHE_MS; return value; }, error => { if (catalogCache.get(provider) === entry) catalogCache.delete(provider); throw error; }) };
  catalogCache.set(provider, entry);
  return entry.value;
}

export async function cliReasoningArgs(provider: string, model: string, reasoning?: ReasoningSelection): Promise<string[]> {
  if (reasoning == null) return [];
  if (provider !== 'codex') throw new CliModelError('Reasoning selection is not supported by this CLI');
  if (model === 'codex') throw new CliModelError('Choose a concrete model before overriding its reasoning effort');
  const catalog = await discoverCliModels(provider);
  const selected = catalog.models.find(entry => entry.id === model);
  if (!selected) throw new CliModelError('Selected model is not available; recheck the CLI model catalog');
  const effort = reasoning === 'default' ? selected.defaultReasoningEffort : reasoning;
  if (!effort || !selected.reasoningEfforts.includes(effort)) throw new CliModelError('Selected reasoning effort is not supported by this model');
  return ['-c', `model_reasoning_effort="${effort}"`];
}
