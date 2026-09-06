import { launchBrowser, createStealthContext } from '../scraper/browser';
import { COUNTRY_PROFILES } from '../scraper/country-profiles';
import { bookingSearchUrl } from './booking';
import { googleSearchUrl, selectGoogleTotal } from './google';
import type { HotelPageCapture } from './extraction';
import { extractBookingOffers } from './booking-extraction';
import { extractGoogleOffers } from './google-extraction';
import { navigateHotelPage } from './navigation';
import { captureBookingRates } from './booking-capture';
import { captureHotelLinks } from './link-capture';
import type { HotelOffer, HotelSearch, HotelSelection, HotelSource, HotelStay } from './types';

export const HOTEL_DISCOVERY_LIMIT = 8;

export class PartialHotelSourceError extends Error {
  constructor(public readonly offers: HotelOffer[], public readonly errors: string[]) {
    super(errors.join('; '));
    this.name = 'PartialHotelSourceError';
  }
}

export async function captureHotelSource(search: HotelSearch, stay: HotelStay, source: HotelSource, selection?: HotelSelection): Promise<HotelPageCapture> {
  const url = source === 'booking' ? bookingSearchUrl(search, stay, selection) : googleSearchUrl(search, stay, selection);
  const browser = await launchBrowser();
  try {
    const profile = COUNTRY_PROFILES.GB!;
    const context = await createStealthContext(browser, { countryProfile: profile });
    const page = await context.newPage();
    await navigateHotelPage(page, url, source);
    const totalPriceBasis = source === 'google_hotels' ? await selectGoogleTotal(page) : '';
    await page.waitForTimeout(1500);
    const text = await page.locator('body').innerText();
    if (/verify (?:that )?you(?:'re| are) human|unusual traffic|captcha|access denied/i.test(text)) throw new Error(`${source} blocked headless access`);
    const controls = await page.locator('input,select,button,[role="combobox"]').evaluateAll(elements => elements.filter(e => !(e instanceof HTMLInputElement) || e.type !== 'hidden' || /^(checkin|checkout|group_|req_|age|room|interval)|date|stay/.test(e.name)).map(e => {
      const label = e.getAttribute('aria-label') ?? '';
      const value = e instanceof HTMLInputElement || e instanceof HTMLSelectElement ? `${e.name}=${e.value}` : e.textContent;
      const guests = /^(Add|Remove) (adult|child)$/.test(label) ? e.parentElement?.parentElement?.textContent ?? '' : '';
      return `${label} ${value} ${guests}`;
    }).join('\n'));
    const links = await captureHotelLinks(page, source);
    const images = await page.locator('img').evaluateAll(elements => elements.map(element => {
      const e = element as HTMLImageElement;
      return { alt: e.alt, url: e.currentSrc || e.src };
    }));
    const rates = source === 'booking' ? await captureBookingRates(page) : [];
    const metadata = await page.evaluate(() => ({
      propertyName: ((document.querySelector('#hp_hotel_name h2') ?? document.querySelector('.pp-header__title h2') ?? document.querySelector('#hp_hotel_name') ?? document.querySelector('.pp-header__title') ?? document.querySelector('h1')) as HTMLElement | null)?.innerText?.trim().split('\n').filter(Boolean).at(-1),
      address: (document.querySelector('.hp_address_subtitle') as HTMLElement | null)?.innerText?.trim(),
      starsLabel: [...(document.querySelector('#hp_hotel_name,.pp-header__title')?.parentElement?.parentElement?.querySelectorAll('[aria-label],[title]') ?? [])].map(element => element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '').find(label => /[1-5] (?:out of 5|stars)/i.test(label)),
    }));
    return { url: page.url(), text: text.slice(0, 90000), controls: controls.slice(0, 20000), links: links.slice(0, 150), images: images.filter(image => /(?:bstatic\.com.*\/hotel\/|googleusercontent\.com)/.test(image.url)).slice(0, 12), rates, totalPriceBasis, ...metadata };
  } finally {
    await browser.close();
  }
}

export async function searchHotelSource(search: HotelSearch, stay: HotelStay, source: HotelSource, selection?: HotelSelection): Promise<HotelOffer[]> {
  const capture = await captureHotelSource(search, stay, source, selection);
  if (selection) return source === 'booking' ? extractBookingOffers(capture, search, stay, selection) : extractGoogleOffers(capture, search, stay);
  if (source === 'booking' && capture.rates?.length) return extractBookingOffers(capture, search, stay);
  if (source === 'google_hotels' && capture.totalPriceBasis && capture.propertyName) return extractGoogleOffers(capture, search, stay);
  const candidates = capture.links.filter(link => {
    const url = new URL(link.url);
    return source === 'booking'
      ? url.hostname === 'www.booking.com' && url.pathname.startsWith('/hotel/')
      : url.hostname === 'www.google.com' && link.text.trim() === 'View prices' && url.pathname.startsWith('/travel/');
  });
  const seen = new Set<string>();
  const unique = candidates.filter(link => {
    const url = new URL(link.url);
    const key = source === 'booking' ? url.pathname : url.searchParams.get('qs') ?? url.pathname;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, HOTEL_DISCOVERY_LIMIT);
  if (!unique.length) throw new Error(`${source} did not return property links for this search`);
  const offers: HotelOffer[] = [];
  const errors: string[] = [];
  for (const link of unique) {
    const property = { propertyId: '', source, hotelName: search.destination, propertyUrl: link.url, roomName: null, rateName: null, seller: '', refundable: null, breakfast: null };
    try {
      const detail = await captureHotelSource(search, stay, source, property);
      offers.push(...(source === 'booking' ? extractBookingOffers(detail, search, stay) : extractGoogleOffers(detail, search, stay)));
    } catch (error) {
      errors.push(`${new URL(link.url).pathname}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) throw new PartialHotelSourceError(offers, errors);
  return offers;
}
