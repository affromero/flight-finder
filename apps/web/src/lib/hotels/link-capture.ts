import type { Page } from 'playwright';
import type { HotelSource } from './types';

export async function captureHotelLinks(page: Page, source: HotelSource) {
  return page.locator('a[href]').evaluateAll((elements, visibleOnly) => elements
    .filter(element => !visibleOnly || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    .slice(0, 150)
    .map(element => {
      const anchor = element as HTMLAnchorElement;
      const seller = anchor.querySelector('[aria-label^="Visit site for"]')?.getAttribute('aria-label')?.replace(/^Visit site for\s*/, '');
      return { text: anchor.innerText ?? '', url: anchor.href, seller };
    }), source === 'google_hotels');
}
