/**
 * Tests for the sliding window provider rate limiter (issue 65 audit
 * D3). The limiter is stateful at module scope, so each test calls
 * _resetRateLimitForTests in beforeEach to start with a fresh quota.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockConfigFindFirst = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/prisma', () => ({
  prisma: { extractionConfig: { findFirst: (...args: unknown[]) => mockConfigFindFirst(...args) } },
}));

import { acquireProviderToken, _resetRateLimitForTests } from './rate-limit';

beforeEach(() => {
  _resetRateLimitForTests();
  mockConfigFindFirst.mockResolvedValue(null); // no DB override by default
  process.env.GOOGLE_RPM = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('acquireProviderToken', () => {
  it('returns immediately for unlimited providers (ollama)', async () => {
    const start = Date.now();
    await acquireProviderToken('ollama');
    await acquireProviderToken('ollama');
    await acquireProviderToken('ollama');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('returns immediately for CLI providers (claude-code)', async () => {
    const start = Date.now();
    await acquireProviderToken('claude-code');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('admits up to RPM calls within the 60 second window without blocking', async () => {
    // Default Google RPM is 15. The first 15 acquires should all
    // resolve essentially instantly.
    const start = Date.now();
    for (let i = 0; i < 15; i++) {
      await acquireProviderToken('google');
    }
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('blocks the (RPM+1)th call until a slot frees up', async () => {
    vi.useFakeTimers();
    // Fill the window: 15 acquires for google at t=0.
    for (let i = 0; i < 15; i++) {
      await acquireProviderToken('google');
    }

    // The 16th call should be waiting on a setTimeout.
    const sixteenth = acquireProviderToken('google');
    let resolved = false;
    void sixteenth.then(() => { resolved = true; });

    // 30 seconds in: still waiting.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolved).toBe(false);

    // Just past 60 seconds: the oldest timestamp falls out of the
    // window, the wait completes.
    await vi.advanceTimersByTimeAsync(31_000);
    await sixteenth;
    expect(resolved).toBe(true);
  });

  it('applies an admin-configured RPM override from the DB', async () => {
    vi.useFakeTimers();
    mockConfigFindFirst.mockResolvedValue({ anthropicRpm: 2, googleRpm: null, openaiRpm: null, groqRpm: null });
    _resetRateLimitForTests(); // drop the cached overrides so the new value is read

    // With anthropic capped at 2, the first two admit instantly and the third blocks.
    await acquireProviderToken('anthropic');
    await acquireProviderToken('anthropic');
    const third = acquireProviderToken('anthropic');
    let resolved = false;
    void third.then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);
    await third;
    expect(resolved).toBe(true);
  });

  it('isolates counters per provider', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 15; i++) {
      await acquireProviderToken('google');
    }
    // Google bucket is full. Anthropic should still admit immediately.
    const start = Date.now();
    await acquireProviderToken('anthropic');
    expect(Date.now() - start).toBeLessThan(50);
  });
});
