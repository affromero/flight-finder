/**
 * Global vitest setup — starts an LLMock server that catches any real SDK
 * calls that escape vi.mock(). This prevents 401 errors from leaked API
 * requests during tests.
 */
import net from 'node:net';
import { LLMock } from '@copilotkit/llmock';

const LLMOCK_PORT = 19876;

let mock: LLMock | null = null;

/** Resolve true when nothing is listening on the port yet. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

export async function setup() {
  // A killed test run (Ctrl+C, timeout) leaves the LLMock server orphaned on
  // the fixed port. It is a static catch-all, so a leftover instance serves
  // identically: reuse it rather than crashing the whole suite with an
  // unhandled EADDRINUSE bind error. Pre-check instead of catching, because
  // LLMock surfaces the failure as an async server 'error' event, not a
  // rejected start() promise.
  if (!(await portIsFree(LLMOCK_PORT))) return;

  const instance = new LLMock({ port: LLMOCK_PORT });

  // Default fallback: return a valid but empty response for any unmatched request
  instance.onMessage(/./, {
    content: '[]',
  });

  await instance.start();
  mock = instance;
}

export async function teardown() {
  // Only stop the server this run actually started; a reused leftover is left
  // alone for whoever owns it.
  if (mock) {
    await mock.stop();
    mock = null;
  }
}
