import {
  ProcessRunner,
  ProcessExecutionError,
} from 'thesidedoor-core/runtime/process';
import {
  ClaudeOutputDecoder,
  CliProtocolError,
  type CliOutputEvent,
} from 'thesidedoor-core/runtime/cli';
import { GenerationUsageError } from 'thesidedoor-core/ai/usage';
import type { TokenUsage } from 'thesidedoor-core/ai';
import type { ExtractOptions, ExtractionResult } from './ai-registry';
import { cliEnvironment } from './cli-environment';

export async function extractClaude(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options?: ExtractOptions,
): Promise<ExtractionResult> {
  options?.signal?.throwIfAborted();
  const environment = cliEnvironment('claude-code');
  // Subscription extraction must not inherit an API endpoint or API credentials.
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  delete environment.ANTHROPIC_BASE_URL;
  const decoder = new ClaudeOutputDecoder({
    maximumLineChars: options?.signal
      ? 16 * 1024 * 1024
      : Number.MAX_SAFE_INTEGER,
  });
  let content = '';
  let usage: TokenUsage | undefined;
  let failure = '';
  let terminalFailure = false;
  let stderr = '';
  let stdout = '';
  let finished = false;
  let answerBytes = 0;
  let stderrBytes = 0;
  const observe = (events: Iterable<CliOutputEvent>) => {
    for (const event of events) {
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'failure') {
        terminalFailure = true;
        failure = event.message;
      }
      if (event.type === 'text') {
        answerBytes += Buffer.byteLength(event.text);
        if (options?.signal && answerBytes > 64000)
          throw new Error('Inference output exceeded the allowed size');
        content += event.text;
      }
    }
  };
  const diagnostic = () => {
    const plainTextFailure = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) =>
        /^(?:error:\s*)?(?:not logged in\b|oauth\b|failed to authenticate\b|401\b|unauthorized\b|usage limit\b)/i.test(
          line,
        ),
      )
      .join('\n');
    return (
      failure ||
      stderr
        .split('\n')
        .filter((line) => !line.includes('could not update PATH'))
        .join('\n')
        .trim() ||
      plainTextFailure ||
      '(no output)'
    ).slice(-4096);
  };
  try {
    for await (const chunk of new ProcessRunner().stream({
      command: 'claude',
      args: [
        '--print',
        '--model',
        model,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'default',
        '--disallowedTools',
        'Bash,Edit,MultiEdit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite',
      ],
      environment,
      input: `${systemPrompt}\n\n${userPrompt}`,
      timeoutMs: 240000,
      signal: options?.signal,
      // Protocol summaries can repeat the answer; bound transport separately from answer bytes.
      maxOutputBytes: options?.signal
        ? 16 * 1024 * 1024
        : Number.MAX_SAFE_INTEGER,
    })) {
      if (chunk.channel === 'stderr') {
        stderrBytes += Buffer.byteLength(chunk.text);
        if (options?.signal && stderrBytes > 64000)
          throw new Error('Inference output exceeded the allowed size');
        stderr = (stderr + chunk.text).slice(-4096);
      } else {
        stdout = (stdout + chunk.text).slice(0, 4096);
        observe(decoder.push(chunk.text));
      }
    }
    finished = true;
    observe(decoder.finish());
    if (terminalFailure) throw new Error(`claude CLI failed: ${diagnostic()}`);
    options?.signal?.throwIfAborted();
    return {
      content: content.trim(),
      usage: usage ?? { inputTokens: null, outputTokens: null },
    };
  } catch (error) {
    if (!finished) {
      try {
        observe(decoder.finish(false));
      } catch {
        /* Preserve the process error. */
      }
    }
    let reported = error;
    if (error instanceof ProcessExecutionError && error.code === 'output_limit')
      reported = new Error('Inference output exceeded the allowed size', {
        cause: error,
      });
    if (
      error instanceof ProcessExecutionError &&
      error.code === 'start_failed' &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    )
      reported = new Error(
        'claude CLI not found. Restart the container to trigger install.',
        { cause: error },
      );
    else if (
      error instanceof ProcessExecutionError &&
      error.code === 'exit_failed'
    )
      reported = new Error(
        `claude CLI exited ${error.exitCode}: ${diagnostic()}`,
        { cause: error },
      );
    else if (
      diagnostic() !== '(no output)' &&
      error instanceof CliProtocolError
    )
      reported = new Error(`claude CLI failed: ${diagnostic()}`, {
        cause: error,
      });
    if (usage)
      throw new GenerationUsageError(
        reported instanceof Error
          ? reported.message
          : 'Claude execution failed',
        usage,
        { cause: reported },
      );
    throw reported;
  }
}
