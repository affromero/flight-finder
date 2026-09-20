import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ProcessRunner,
  ProcessExecutionError,
} from 'thesidedoor-core/runtime/process';
import {
  CodexOutputDecoder,
  CliProtocolError,
  type CliOutputEvent,
} from 'thesidedoor-core/runtime/cli';
import { GenerationUsageError } from 'thesidedoor-core/ai/usage';
import type { TokenUsage } from 'thesidedoor-core/ai';
import type { ExtractOptions, ExtractionResult } from './ai-registry';
import { cliEnvironment } from './cli-environment';
import { cliReasoningArgs } from './cli-models';

async function removeOutput(
  directory: string,
  primary: { error: unknown } | undefined,
  usage: TokenUsage | undefined,
) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    const reported = primary
      ? new AggregateError(
          [primary.error, error],
          'Codex execution and cleanup failed',
          { cause: error },
        )
      : error;
    if (usage)
      throw new GenerationUsageError(
        'Codex temporary file cleanup failed',
        usage,
        { cause: reported },
      );
    throw reported;
  }
}

/** Extraction returns Codex's final-answer file, independently from intermediate agent messages. */
export async function extractCodex(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options?: ExtractOptions,
): Promise<ExtractionResult> {
  options?.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'codex-'));
  const outputFile = join(directory, 'output.txt');
  const decoder = new CodexOutputDecoder(
    options?.signal ? 16 * 1024 * 1024 : Number.MAX_SAFE_INTEGER,
  );
  let finished = false;
  let usage: TokenUsage | undefined;
  let diagnostics = '';
  let stdoutDiagnostic = '';
  let terminalFailure = false;
  let primary: { error: unknown } | undefined;
  const observe = (events: Iterable<CliOutputEvent>) => {
    for (const event of events) {
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'failure') {
        terminalFailure = true;
        diagnostics = (diagnostics + '\n' + event.message).slice(-4096);
      }
    }
  };
  const failureMessage = (code: number | null) => {
    const detail =
      diagnostics
        .split('\n')
        .filter((line) => !line.includes('could not update PATH'))
        .join('\n')
        .trim() || '(no output)';
    const hint = /401|Unauthorized/.test(detail)
      ? ' (ensure codex is authenticated on the host via `codex auth` and ~/.codex is readable)'
      : '';
    return `codex CLI exited ${code}: ${detail}${hint}`;
  };
  try {
    const reasoning = await cliReasoningArgs(
      'codex',
      model,
      options?.reasoningEffort,
    );
    const bytes = { stdout: 0, stderr: 0 };
    for await (const chunk of new ProcessRunner().stream({
      command: 'codex',
      args: [
        'exec',
        '-',
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        ...(model && model !== 'codex' ? ['--model', model] : []),
        ...reasoning,
        '-s',
        'read-only',
        '-o',
        outputFile,
      ],
      environment: cliEnvironment('codex'),
      cwd: directory,
      input: `${systemPrompt}\n\n${userPrompt}`,
      signal: options?.signal,
      timeoutMs: 240000,
      // Protocol envelopes can repeat the answer; limit final answer bytes separately.
      maxOutputBytes: options?.signal ? 16 * 1024 * 1024 + 64000 : Number.MAX_SAFE_INTEGER,
    })) {
      bytes[chunk.channel] += Buffer.byteLength(chunk.text);
      const channelLimit = chunk.channel === 'stderr' ? 64000 : 16 * 1024 * 1024;
      if (options?.signal && bytes[chunk.channel] > channelLimit)
        throw new Error('Inference output exceeded the allowed size');
      if (chunk.channel === 'stderr')
        diagnostics = (diagnostics + chunk.text).slice(-4096);
      else {
        stdoutDiagnostic = (stdoutDiagnostic + chunk.text).slice(0, 4096);
        observe(decoder.push(chunk.text));
      }
    }
    finished = true;
    observe(decoder.finish());
    if (terminalFailure) throw new Error(failureMessage(1));
    if (options?.signal && (await stat(outputFile)).size > 64000)
      throw new Error('Inference output exceeded the allowed size');
    return {
      content: (await readFile(outputFile, 'utf8')).trim(),
      usage: usage ?? { inputTokens: null, outputTokens: null },
    };
  } catch (error) {
    const legacyDiagnostic = stdoutDiagnostic.split('\n').map(line => line.trim()).filter(line =>
      /^(?:error:\s*)?(?:not logged in\b|failed to authenticate\b|401\b|unauthorized\b|usage limit\b)/i.test(line),
    ).join('\n');
    if (legacyDiagnostic)
      diagnostics = (diagnostics + '\n' + legacyDiagnostic).slice(-4096);
    if (!finished) {
      finished = true;
      try {
        observe(decoder.finish(false));
      } catch {
        /* An incomplete event cannot replace the execution failure. */
      }
    }
    let reported = error;
    if (legacyDiagnostic && error instanceof CliProtocolError)
      reported = new Error(failureMessage(1), { cause: error });
    if (
      error instanceof ProcessExecutionError &&
      error.code === 'start_failed' &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    )
      reported = new Error(
        'codex CLI not found. Restart the container to trigger install.',
        { cause: error },
      );
    if (error instanceof ProcessExecutionError && error.code === 'exit_failed')
      reported = new Error(failureMessage(error.exitCode), { cause: error });
    if (
      (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' &&
      finished
    )
      reported = new Error('codex CLI did not produce its final output file', {
        cause: error,
      });
    if (usage)
      reported = new GenerationUsageError(
        reported instanceof Error ? reported.message : 'Codex execution failed',
        usage,
        { cause: reported },
      );
    primary = { error: reported };
    throw reported;
  } finally {
    await removeOutput(directory, primary, usage);
  }
}
