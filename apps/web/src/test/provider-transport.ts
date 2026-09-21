import type { Browser, Route } from 'playwright';

/** Keep browser, redirects and DOM processing real; replace only provider HTTP transport. */
export function routeProviderTransport(browser: Browser, origin: string): Browser {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options), newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage(), register = page.route.bind(page);
      const fetch = (url: string, options?: Parameters<Route['fetch']>[0]) => {
        const target = new URL(url);
        return context.request.get(`${origin}/${target.hostname}${target.pathname}${target.search}`, { ...options, maxRedirects: 0 });
      };
      await register('**/*', async route => { await route.fulfill({ response: await fetch(route.request().url()) }); });
      page.route = async (pattern, handler, options) => register(pattern, async (route, request) => {
        route.fetch = options => fetch(request.url(), options);
        await handler(route, request);
      }, options);
      return page;
    };
    return context;
  };
  return browser;
}
