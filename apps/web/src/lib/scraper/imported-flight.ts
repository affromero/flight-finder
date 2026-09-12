import { launchBrowser, createStealthContext } from './browser';
import { closeTravelBrowser } from '../travel/execution';
import { guardTravelNavigation } from '../travel/navigation';
import { readFlightLink, assertFlightLinkSearch, type FlightLink } from './flight-link';
import { extractPrices, type QueryFilters, type ExtractionConfigOverride } from './extract-prices';
import type { FlightSearchParams } from './navigate';
import type { CountryProfile } from './country-profiles';

export function verifyImportedFlightPage(link: FlightLink, finalUrl: string, text: string): void {
  const actual = readFlightLink(finalUrl);
  if (JSON.stringify(actual.legs) !== JSON.stringify(link.legs) || actual.cabinClass !== link.cabinClass) throw new Error('Google changed the selected itinerary; no substitute flight was used');
  if (/unusual traffic|captcha|access denied|no booking options|flight.*unavailable/i.test(text)) throw new Error('The selected itinerary could not be priced');
  for (const [index, leg] of link.legs.entries()) {
    const section = index === 0 ? text.split('Departing flight')[1]?.split('Returning flight')[0] : text.split('Returning flight')[1];
    if (!section) throw new Error('Google did not display the selected flight details');
    const departure = leg[0]!.date, date = new Date(`${departure}T12:00:00Z`), month = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    if (!section.includes(departure) && !new RegExp(`\\b${month}\\s+${date.getUTCDate()}\\b|\\b${date.getUTCDate()}\\s+${month}\\b`, 'i').test(section)) throw new Error('Google did not display the selected flight dates');
    let offset = 0;
    for (const segment of leg) {
      const number = new RegExp(`${segment.airline}\\s*${segment.number}\\b`).exec(section.slice(offset));
      if (!number) throw new Error(`Google did not display selected flight ${segment.airline} ${segment.number}`);
      const details = section.slice(offset, offset + number.index);
      if (!details.includes(`(${segment.origin})`) || !details.includes(`(${segment.destination})`)) throw new Error('Google did not verify the selected flight airports');
      const cabin = { economy: 'Economy', premium_economy: 'Premium economy', business: 'Business', first: 'First' }[link.cabinClass];
      if (!details.split('\n').some(line => line.trim().toLowerCase() === cabin.toLowerCase())) throw new Error('Google did not verify the selected cabin on every segment');
      const dayOffset = Math.round((Date.parse(segment.date) - Date.parse(departure)) / 86400000);
      const displayedDeparture = new RegExp(`^\\d{1,2}:\\d{2}\\s*[AP]M(?:\\+(\\d+))?[^\\n]*\\(${segment.origin}\\)`, 'm').exec(details);
      if (!displayedDeparture || Number(displayedDeparture[1] ?? 0) !== dayOffset) throw new Error('Google did not verify the connection departure date');
      offset += number.index + number[0].length;
    }
  }
  if (!/booking options|book with/i.test(text)) throw new Error('Google did not display booking options for the selected itinerary');
}

export async function captureImportedFlight(params: FlightSearchParams & { sourceUrl: string }, countryProfile?: CountryProfile, proxyUrl?: string) {
  assertFlightLinkSearch(params.sourceUrl, { ...params, dateFrom: params.dateFrom.toISOString().slice(0, 10), dateTo: params.dateTo.toISOString().slice(0, 10), cabinClass: params.cabinClass ?? 'economy', tripType: params.tripType ?? 'round_trip' });
  const link = readFlightLink(params.sourceUrl), url = new URL(link.url);
  url.searchParams.set('hl', 'en');
  if (params.currency) url.searchParams.set('curr', params.currency);
  if (params.country) url.searchParams.set('gl', params.country);
  const browser = await launchBrowser({ proxyUrl });
  let failure: unknown;
  try {
    const context = await createStealthContext(browser, { countryProfile, proxyUrl }), page = await context.newPage();
    const guard = await guardTravelNavigation(page, 'imported-flight', destination => destination.protocol === 'https:' && !destination.port && !destination.username && !destination.password && ['www.google.com', 'consent.google.com'].includes(destination.hostname));
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await guard.settle();
    const consent = page.getByRole('button', { name: /^(Reject all|Accept all)$/ }).first();
    if (await consent.isVisible()) { await consent.click(); await page.waitForTimeout(2000); await guard.settle(); }
    await page.getByText(/Booking options|Book with/).first().waitFor({ timeout: 30000 });
    const details = page.getByRole('button', { name: /^Flight details\./ });
    if (await details.count() !== link.legs.length) throw new Error('Google did not return the selected itinerary');
    for (const detail of await details.all()) if (await detail.getAttribute('aria-expanded') !== 'true') await detail.click();
    const html = await page.locator('body').innerText();
    verifyImportedFlightPage(link, page.url(), html);
    const currencyLabel = await page.getByRole('button', { name: /^Currency [A-Z]{3}$/ }).getAttribute('aria-label');
    const currency = currencyLabel?.slice(-3);
    if (!currency || (params.currency && currency !== params.currency)) throw new Error('Google did not verify the requested fare currency');
    return { html, url: url.href, link, currency };
  } catch (error) { failure = error; throw error; }
  finally { await closeTravelBrowser(browser, failure); }
}

export async function scrapeImportedFlight(params: FlightSearchParams & { sourceUrl: string }, filters: QueryFilters, config?: ExtractionConfigOverride, countryProfile?: CountryProfile, proxyUrl?: string) {
  const { html, url, link, currency } = await captureImportedFlight(params, countryProfile, proxyUrl);
  const result = await extractPrices(html, url, link.legs[0]![0]!.date, { ...filters, selectedItinerary: link.legs }, 1, true, 'google_flights', currency, config);
  const first = link.legs[0]![0]!;
  const bookingLines = html.split('Booking options')[1]?.split('Price insights')[0]?.split('\n').map(line => line.trim()) ?? [];
  const prices = result.prices.filter(price => {
    if (price.travelDate !== first.date || price.currency !== currency) return false;
    return (['symbol', 'narrowSymbol', 'code'] as const).some(currencyDisplay => {
      const displayed = new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(price.price).replace(/\s/g, '');
      return bookingLines.some(line => line.replace(/\s/g, '') === displayed);
    });
  });
  return { ...result, failureReason: prices.length ? result.failureReason : result.failureReason ?? 'empty_extraction' as const,
    prices: prices.map(price => ({ ...price, bookingUrl: link.url, flightNumber: `${first.airline} ${first.number}` })) };
}
