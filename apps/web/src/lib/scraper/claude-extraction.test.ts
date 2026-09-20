import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { usageFromGenerationError } from 'thesidedoor-core/ai/usage';
import { extractClaude } from './claude-extraction';

let directory: string;
function executable(body: string) {
  writeFileSync(
    join(directory, 'claude'),
    `#!${process.execPath}
const fs=require('node:fs');
const event=value=>console.log(JSON.stringify(value));
const usage={input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,output_tokens:7};
${body}`,
    { mode: 0o700 },
  );
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'flight-claude-test-'));
  vi.stubEnv('PATH', directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it('preserves prompt, tool restrictions and subscription isolation while measuring usage', async () => {
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'UNRELATED_SECRET',
  ])
    vi.stubEnv(key, 'private-test-value');
  executable(`let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
    event({type:'result',usage,result:JSON.stringify({input,args:process.argv.slice(2),env:process.env})});
  });`);
  const result = await extractClaude('chosen-model', 'rules', 'question');
  const answer = JSON.parse(result.content);
  expect(answer.input).toBe('rules\n\nquestion');
  expect(answer.args).toEqual(
    expect.arrayContaining([
      '--model',
      'chosen-model',
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
    ]),
  );
  expect(answer.args[answer.args.indexOf('--permission-mode') + 1]).toBe(
    'default',
  );
  const denied =
    answer.args[answer.args.indexOf('--disallowedTools') + 1].split(',');
  expect(denied).toEqual(
    expect.arrayContaining([
      'Bash',
      'Read',
      'Write',
      'Edit',
      'WebFetch',
      'Task',
    ]),
  );
  expect(answer.args).not.toContain('--dangerously-skip-permissions');
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'UNRELATED_SECRET',
  ])
    expect(answer.env[key]).toBeUndefined();
  expect(answer.env.PATH).toBe(directory);
  expect(result.usage).toMatchObject({
    inputTokens: 35,
    outputTokens: 7,
    cachedInputTokens: 20,
  });
});

it('trims the answer without duplicating terminal text or emitting tool content', async () => {
  executable(
    `event({type:'assistant',message:{content:[{type:'tool_use',text:'private tool text'},{type:'text',text:'  answer  '}]}});event({type:'result',result:'  answer  '});`,
  );
  expect(await extractClaude('model', '', '')).toEqual({
    content: 'answer',
    usage: { inputTokens: null, outputTokens: null },
  });
});

it.each([0, 7])(
  'preserves terminal usage and quota diagnostics on failure (exit %s)',
  async (code) => {
    executable(
      `process.stdout.write(JSON.stringify({type:'result',is_error:true,errors:['Usage limit reached'],usage}));process.exitCode=${code};`,
    );
    const error = await extractClaude('model', '', '').catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({
      message: expect.stringContaining('Usage limit reached'),
    });
    expect(usageFromGenerationError(error)).toMatchObject({
      inputTokens: 35,
      outputTokens: 7,
    });
  },
);

it('preserves plain authentication errors from an older CLI', async () => {
  executable(
    "process.stdout.write('Failed to authenticate: OAuth session expired and could not be refreshed');process.exitCode=1;",
  );
  await expect(extractClaude('model', '', '')).rejects.toThrow(
    'OAuth session expired',
  );
});

it('reports missing executable and incomplete structured output', async () => {
  await expect(extractClaude('model', '', '')).rejects.toThrow(
    'claude CLI not found. Restart the container',
  );
  executable(
    "event({type:'assistant',message:{content:[{type:'text',text:'partial'}]}});",
  );
  await expect(extractClaude('model', '', '')).rejects.toThrow('completion');
});

it.each([true, false])(
  'preserves controlled Unicode output bounds (controlled %s)',
  async (controlled) => {
    executable("event({type:'result',result:'é'.repeat(32001)});");
    const promise = extractClaude(
      'model',
      '',
      '',
      controlled ? { signal: new AbortController().signal } : undefined,
    );
    if (controlled)
      await expect(promise).rejects.toThrow('exceeded the allowed size');
    else expect((await promise).content.length).toBe(32001);
  },
  15_000,
);

it('settles the child before returning cancellation', async () => {
  executable(
    `fs.writeFileSync(${JSON.stringify(join(directory, 'pid'))},String(process.pid));setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  const reason = new Error('cancelled test');
  const promise = extractClaude('model', '', '', { signal: controller.signal });
  const settled = promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.waitFor(
    () => expect(existsSync(join(directory, 'pid'))).toBe(true),
    { timeout: 10_000 },
  );
  const pid = Number(readFileSync(join(directory, 'pid'), 'utf8'));
  controller.abort(reason);
  expect(await settled).toBe(reason);
  expect(() => process.kill(pid, 0)).toThrow();
});

it('accepts a full-size answer when structured summaries repeat it', async () => {
  executable(
    "const text='é'.repeat(32000);event({type:'assistant',message:{content:[{type:'text',text}]}});event({type:'result',result:text});",
  );
  expect(
    (
      await extractClaude('model', '', '', {
        signal: new AbortController().signal,
      })
    ).content,
  ).toBe('é'.repeat(32000));
});

it('bounds non-answer protocol data and reports the existing size error', async () => {
  executable(
    "event({type:'system',metadata:'x'.repeat(16*1024*1024)});setInterval(()=>{},1000);",
  );
  await expect(
    extractClaude('model', '', '', { signal: new AbortController().signal }),
  ).rejects.toThrow('exceeded the allowed size');
});

it('rejects a terminal failure even when its result text is empty', async () => {
  executable("event({type:'result',is_error:true,result:''});");
  await expect(extractClaude('model', '', '')).rejects.toThrow(
    'claude CLI failed',
  );
});
