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
import { extractCodex } from './codex-extraction';

let directory: string;
function executable(body: string) {
  writeFileSync(
    join(directory, 'codex'),
    `#!${process.execPath}
    const fs=require('node:fs');
    const output=process.argv[process.argv.indexOf('-o')+1];
    const event=value=>console.log(JSON.stringify(value));
    const done=()=>event({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:30}});
    fs.writeFileSync(${JSON.stringify(join(directory, 'cwd'))},process.cwd());
    ${body}
  `,
    { mode: 0o700 },
  );
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'flight-codex-test-'));
  vi.stubEnv('PATH', directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it('returns only the final file and retains measured usage, sandbox and credential isolation', async () => {
  vi.stubEnv('UNRELATED_APP_SECRET', 'private-test-value');
  vi.stubEnv('CODEX_API_KEY', 'cli-test-key');
  executable(`let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
    event({type:'item.completed',item:{id:'intermediate',type:'agent_message',text:'intermediate answer'}});
    fs.writeFileSync(output,JSON.stringify({input,args:process.argv.slice(2),key:process.env.CODEX_API_KEY,leaked:process.env.UNRELATED_APP_SECRET}));done();
  });`);
  const result = await extractCodex('chosen-model', 'rules', 'question');
  const answer = JSON.parse(result.content);
  expect(answer.input).toBe('rules\n\nquestion');
  expect(answer.args).toEqual(
    expect.arrayContaining([
      '--json',
      '--ephemeral',
      'read-only',
      'chosen-model',
    ]),
  );
  expect(answer.key).toBe('cli-test-key');
  expect(answer.args[answer.args.indexOf('-s') + 1]).toBe('read-only');
  expect(answer.args).not.toContain('danger-full-access');
  expect(answer.args).not.toContain(
    '--dangerously-bypass-approvals-and-sandbox',
  );
  expect(answer.leaked).toBeUndefined();
  expect(result.usage).toMatchObject({
    inputTokens: 100,
    outputTokens: 30,
    cachedInputTokens: 40,
  });
  expect(existsSync(readFileSync(join(directory, 'cwd'), 'utf8'))).toBe(false);
});

it('preserves measured usage on failed exit without a final newline or output file', async () => {
  executable(
    `process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:30}}));process.exitCode=7;`,
  );
  const error = await extractCodex('codex', '', 'question').catch(
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ message: expect.stringContaining('exited 7') });
  expect(usageFromGenerationError(error)).toMatchObject({
    inputTokens: 100,
    outputTokens: 30,
  });
  expect(existsSync(readFileSync(join(directory, 'cwd'), 'utf8'))).toBe(false);
});

it.each([true, false])(
  'rejects missing final output or completion (completion %s)',
  async (complete) => {
    executable(
      complete ? 'done();' : "fs.writeFileSync(output,'unconfirmed answer');",
    );
    await expect(extractCodex('codex', '', 'question')).rejects.toThrow(
      complete ? 'final output file' : 'completion',
    );
  },
);

it('keeps authentication guidance from structured stdout errors', async () => {
  executable("event({type:'turn.failed',error:{message:'401 Unauthorized'}});");
  await expect(extractCodex('codex', '', 'question')).rejects.toThrow(
    'ensure codex is authenticated',
  );
});

it('preserves authentication failures printed as plain stdout by CLI processes', async () => {
  executable(
    "console.log('Not logged in. Run codex auth.');process.exitCode=1;",
  );
  await expect(extractCodex('codex', '', 'question')).rejects.toThrow(
    'Not logged in',
  );
}, 15_000);

it('preserves a recognized authentication error after a CLI banner', async () => {
  executable("process.stdout.write('Codex CLI\\n401 Unauthorized\\n');process.exitCode=1;");
  await expect(extractCodex('codex', '', 'question')).rejects.toThrow('ensure codex is authenticated');
});

it.each(['401 Unauthorized', 'some other error'])(
  'preserves stderr diagnostics: %s',
  async (message) => {
    executable(
      `process.stderr.write(${JSON.stringify(message)});process.exitCode=1;`,
    );
    const error = await extractCodex('codex', '', 'question').catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ message: expect.stringContaining(message) });
    if (message.includes('401'))
      expect((error as Error).message).toContain(
        'ensure codex is authenticated',
      );
    else expect((error as Error).message).not.toContain('codex auth');
  },
);

it('terminates oversized controlled stderr before returning the size error', async () => {
  executable(
    `fs.writeFileSync(${JSON.stringify(join(directory, 'pid'))},String(process.pid));process.stderr.write('x'.repeat(64001));setInterval(()=>{},1000);`,
  );
  await expect(
    extractCodex('codex', '', 'question', {
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('exceeded the allowed size');
  const pid = Number(readFileSync(join(directory, 'pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
});

it('reports an absent binary with the existing installation guidance', async () => {
  await expect(extractCodex('codex', '', 'question')).rejects.toThrow(
    'codex CLI not found. Restart the container',
  );
});

it('accepts a full-size answer when JSON events repeat its text', async () => {
  executable(`const text='é'.repeat(32000);
    event({type:'item.started',item:{id:'answer',type:'agent_message',text}});
    event({type:'item.completed',item:{id:'answer',type:'agent_message',text}});
    fs.writeFileSync(output,text);done();`);
  const result = await extractCodex('codex', '', 'question', { signal: new AbortController().signal });
  expect(result.content).toBe('é'.repeat(32000));
  expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 30 });
});

it.each([true, false])(
  'preserves Unicode byte limits for controlled extraction (controlled %s)',
  async (controlled) => {
    executable("fs.writeFileSync(output,'é'.repeat(32001));done();");
    const promise = extractCodex(
      'codex',
      '',
      'question',
      controlled ? { signal: new AbortController().signal } : undefined,
    );
    if (controlled)
      await expect(promise).rejects.toThrow('exceeded the allowed size');
    else expect((await promise).content.length).toBe(32001);
  },
);

it('terminates the child and removes its temporary directory before cancellation returns', async () => {
  executable(
    `fs.writeFileSync(${JSON.stringify(join(directory, 'pid'))},String(process.pid));setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  const reason = new Error('cancelled test extraction');
  const promise = extractCodex('codex', '', 'question', {
    signal: controller.signal,
  });
  const rejected = promise.then(
    () => expect.unreachable('cancelled extraction resolved'),
    (error) => expect(error).toBe(reason),
  );
  await vi.waitFor(() => expect(existsSync(join(directory, 'pid'))).toBe(true), {
    timeout: 10_000,
  });
  const pid = Number(readFileSync(join(directory, 'pid'), 'utf8'));
  controller.abort(reason);
  await rejected;
  expect(() => process.kill(pid, 0)).toThrow();
  expect(existsSync(readFileSync(join(directory, 'cwd'), 'utf8'))).toBe(false);
});
