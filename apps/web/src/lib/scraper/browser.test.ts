import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import { createStealthContext } from './browser';

describe('createStealthContext', () => {
  it('leaves Fetch Metadata headers to Chromium so subrequests retain their request-specific values', async () => {
    const context = {
      addInitScript: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;
    const newContext = vi.fn().mockResolvedValue(context);
    const browser = { newContext } as unknown as Browser;

    await createStealthContext(browser);

    expect(newContext).toHaveBeenCalledOnce();
    const [options] = newContext.mock.calls[0]!;
    expect(options.extraHTTPHeaders).toEqual({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    });
    expect(options.extraHTTPHeaders).not.toHaveProperty('Sec-Fetch-Dest');
    expect(options.extraHTTPHeaders).not.toHaveProperty('Sec-Fetch-Mode');
    expect(options.extraHTTPHeaders).not.toHaveProperty('Sec-Fetch-Site');
    expect(options.extraHTTPHeaders).not.toHaveProperty('Sec-Fetch-User');
  });
});
