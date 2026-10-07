import type { BrowserContext, Page, Route } from 'playwright';

export interface TravelNavigationGuard {
  reset(): void;
  status(): number;
  settle(): Promise<void>;
}

const guards = new WeakMap<Page, { policy: string; guard: TravelNavigationGuard; handle(route: Route): Promise<void> }>();
const routedPages = new WeakMap<Page, ReturnType<Page['route']>>();
const contexts = new WeakMap<BrowserContext, { policy: string; ready: ReturnType<BrowserContext['route']> }>();

/** Fetches redirect hops individually so an allowed origin cannot redirect into a private network. */
function navigationState(page: Page | null, policy: string, allowed: (url: URL) => boolean, maxRedirects = 10) {
  const existing = page ? guards.get(page) : undefined;
  if (existing) {
    if (existing.policy !== policy) throw new Error('A browser page cannot change its navigation security policy');
    return existing;
  }
  let redirects = 0;
  let finalStatus = 0;
  const guard: TravelNavigationGuard = {
    reset() { redirects = 0; finalStatus = 0; },
    status() { return finalStatus; },
    async settle() {
      if (!page) throw new Error('Initial navigation has not created its page');
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-travel-redirect'), undefined, { timeout: 45_000 });
      if (finalStatus >= 400) throw new Error(`Provider returned HTTP ${finalStatus}`);
    },
  };
  const handle = async (route: Route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.fallback();
    if (page && request.frame() !== page.mainFrame()) return route.fallback();
    const destination = new URL(request.url());
    if (!allowed(destination)) return route.abort('blockedbyclient');
    const response = await route.fetch({ maxRedirects: 0, timeout: 45_000 }).catch(() => null);
    if (!response) return route.abort('failed');
    finalStatus = response.status();
    if (!page && finalStatus >= 400) return route.abort('failed');
    const location = response.headers().location;
    if (![301, 302, 303, 307, 308].includes(finalStatus) || !location) return route.fulfill({ response });
    let next: URL;
    try { next = new URL(location, destination); } catch { return route.abort('blockedbyclient'); }
    if (!allowed(next) || ++redirects > maxRedirects || ([307, 308].includes(finalStatus) && request.method() !== 'GET')) return route.abort('blockedbyclient');
    const target = JSON.stringify(next.href).replaceAll('<', '\\u003c');
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<html data-travel-redirect="pending"><script>location.replace(${target})</script></html>` });
  };
  const state = { policy, guard, handle };
  if (page) guards.set(page, state);
  return state;
}

/** Context routing also covers a popup's first request, before its page exists. */
export async function guardTravelNavigation(page: Page, policy: string, allowed: (url: URL) => boolean): Promise<TravelNavigationGuard> {
  const context = page.context();
  let installation = contexts.get(context);
  if (installation && installation.policy !== policy) throw new Error('A browser context cannot change its navigation security policy');
  const state = navigationState(page, policy, allowed);
  if (!installation) {
    const ready = context.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest()) return route.fallback();
      let frame;
      try { frame = request.frame(); } catch { /* A popup's initial POST can precede its frame. */ }
      if (frame && frame !== frame.page().mainFrame()) return route.fallback();
      // Popups reserve one hop for an initial request without a frame. Existing
      // registered pages retain their independent ten-hop redirect allowance.
      await navigationState(frame?.page() ?? null, policy, allowed, 9).handle(route);
    });
    installation = { policy, ready };
    contexts.set(context, installation);
  }
  await installation.ready;
  let registered = routedPages.get(page);
  if (!registered) {
    registered = page.route('**/*', state.handle);
    routedPages.set(page, registered);
  }
  await registered;
  return state.guard;
}
