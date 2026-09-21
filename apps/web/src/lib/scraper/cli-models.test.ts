import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
const offering = { model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] };
function processFixture(args: string[], reply: (id: number) => unknown, auth = true) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; });
  if (args[0] !== 'app-server') {
    queueMicrotask(() => { child.stdout.write('codex-cli 0.153.4'); child.emit('close', args[0] === '--version' || auth ? 0 : 1); });
    return child;
  }
  child.stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk)) as { id?: number };
    if (request.id === undefined) return;
    queueMicrotask(() => child.stdout.write(`${JSON.stringify(request.id === 0 ? { id: 0, result: {} } : reply(request.id!))}\n`));
  });
  return child;
}
beforeEach(() => { vi.resetModules(); spawnMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it('cancels an in-flight CLI readiness process without waiting for its timeout', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  let stopped = false;
  child.kill.mockImplementation(() => { stopped = true; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; });
  spawnMock.mockReturnValue(child);
  const { probeCli } = await import('./cli-models');
  const controller = new AbortController();
  const result = probeCli('codex', controller.signal);
  controller.abort(new Error('Discovery cancelled'));
  await expect(result).rejects.toThrow('Discovery cancelled');
  expect(stopped).toBe(true);
});

it('discovers account models and reasoning across pages while ignoring hidden models', async () => {
  spawnMock.mockImplementation((_binary, args) => processFixture(args, id => ({ id, result: { data: id === 1 ? [{ ...offering, hidden: true }] : [offering], nextCursor: id === 1 ? 'next' : null } })));
  const { discoverCliModels } = await import('./cli-models');
  const result = await discoverCliModels('codex');
  expect(result).toMatchObject({ source: 'live', version: '0.153.4', models: [{ id: 'gpt-5.6-luna', defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium'] }] });
});
it('rejects repeated page cursors without returning a partial catalog', async () => {
  spawnMock.mockImplementation((_binary, args) => processFixture(args, id => ({ id, result: { data: [offering], nextCursor: 'same' } })));
  const { discoverCliModels } = await import('./cli-models');
  await expect(discoverCliModels('codex')).rejects.toThrow(/pagination/);
});
it('rejects malformed model capabilities instead of guessing a thinking level', async () => {
  spawnMock.mockImplementation((_binary, args) => processFixture(args, id => ({ id, result: { data: [{ ...offering, defaultReasoningEffort: 'invented' }], nextCursor: null } })));
  const { discoverCliModels } = await import('./cli-models');
  await expect(discoverCliModels('codex')).rejects.toThrow(/capability/);
});
it('reports signed-out installations without returning models', async () => {
  spawnMock.mockImplementation((_binary, args) => processFixture(args, () => ({}), false));
  const { discoverCliModels } = await import('./cli-models');
  await expect(discoverCliModels('codex')).rejects.toThrow(/not signed in/);
});
it('preserves inherited effort and resolves explicit model-default effort', async () => {
  spawnMock.mockImplementation((_binary, args) => processFixture(args, id => ({ id, result: { data: [offering], nextCursor: null } })));
  const { cliReasoningArgs } = await import('./cli-models');
  expect(await cliReasoningArgs('codex', 'gpt-5.6-luna', null)).toEqual([]);
  expect(await cliReasoningArgs('codex', 'gpt-5.6-luna', 'default')).toEqual(['-c', 'model_reasoning_effort="medium"']);
  expect(await cliReasoningArgs('codex', 'gpt-5.6-luna', 'low')).toEqual(['-c', 'model_reasoning_effort="low"']);
  await expect(cliReasoningArgs('codex', 'gpt-5.6-luna', 'ultra')).rejects.toThrow(/not supported/);
  await expect(cliReasoningArgs('codex', 'codex', 'default')).rejects.toThrow(/concrete model/);
  await expect(cliReasoningArgs('codex', 'codex', 'low')).rejects.toThrow(/concrete model/);
});

it('validates explicit CLI selections without restricting custom API model identifiers', async () => {
  const { validateInferenceSelection } = await import('./inference-selection');
  for (const model of ['/models/model.gguf', 'org/model@revision', 'model+variant']) {
    await expect(validateInferenceSelection('ollama', model, null)).resolves.toMatchObject({ model, reasoningEffort: null });
  }
  await expect(validateInferenceSelection('openai', '', null)).rejects.toThrow(/model ID/);
  await expect(validateInferenceSelection('codex', '--malicious', null)).rejects.toThrow(/model ID/);
});
it('keeps application secrets out of CLI discovery and inference environments', async () => {
  vi.stubEnv('DATABASE_URL', 'private-db'); vi.stubEnv('ADMIN_SESSION_SECRET', 'private-admin'); vi.stubEnv('ANTHROPIC_API_KEY', 'private-key'); vi.stubEnv('PATH', '/safe/bin');
  const { cliEnvironment } = await import('./cli-environment');
  expect(cliEnvironment('codex')).toMatchObject({ PATH: '/safe/bin' });
  expect(JSON.stringify(cliEnvironment('codex'))).not.toMatch(/private-db|private-admin|private-key/);
  expect(JSON.stringify(cliEnvironment('claude-code'))).not.toMatch(/private-db|private-admin|private-key/);
});

it('settles a hung readiness probe and allows a later recheck', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawnMock.mockReturnValue(child);
  const { discoverCliModels } = await import('./cli-models');
  const failure = expect(discoverCliModels('codex')).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(8000);
  await failure;
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  vi.useRealTimers();
  spawnMock.mockImplementation((_binary, args) => processFixture(args, id => ({ id, result: { data: [offering] } })));
  expect((await discoverCliModels('codex', true)).models[0]?.id).toBe('gpt-5.6-luna');
});

it('rejects oversized discovery output without keeping a partial catalog', async () => {
  spawnMock.mockImplementation((_binary, args) => processFixture(args, id => ({ id, result: { data: [offering], padding: 'x'.repeat(520_000) } })));
  const { discoverCliModels } = await import('./cli-models');
  await expect(discoverCliModels('codex')).rejects.toThrow(/size limit/);
});
