import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeProviderTransport } from '@/test/provider-transport';
import { searchHotelSource } from './providers';
import { matchesHotelFilters } from './domain';
import { DEFAULT_HOTEL_FILTERS, type HotelSearch } from './types';

const boundary = vi.hoisted(() => ({ origin: '' }));
vi.mock('playwright', async original => {
  const actual = await original<typeof import('playwright')>();
  return { ...actual, chromium: { ...actual.chromium, launch: async (options: Parameters<typeof actual.chromium.launch>[0]) => routeProviderTransport(await actual.chromium.launch(options), boundary.origin) } };
});

function aggregateScore(score: string, attribute = score): string {
  return `<div id="reviewFloater"><div id="js--hp-gallery-scorecard" data-review-score="${attribute}"><div data-capla-component-boundary="b-property-web-property-page/PropertyReviewScoreRight"><div data-testid="review-score-right-component"><div>${score}</div><div>Rated: Superb ${score}, based on 758 reviews</div></div></div></div><div class="best-review-score">Staff <span aria-label="Scored 9.7 ">9.7</span></div></div>`;
}

function rateCell(id: string, price: number, policy: string): string {
  return `<td><div>Current price £${price}</div><div>Includes taxes and fees</div><div>${policy}</div><div>Breakfast included</div><select name="nr_rooms_${id}"><option value="0">0</option><option value="2">2</option></select></td>`;
}

describe.skipIf(process.env.TRAVEL_BROWSER_TESTS !== '1')('imported hotel property browser flow', () => {
  let server: Server, changed = false;
  let wording = 'Sleeps', sharedRoom = false, ratingMarkup = '', maxAdults = '';
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      if (url.pathname.endsWith('/selected.html')) {
        response.writeHead(302, { location: `https://www.booking.com/hotel/gb/${changed ? 'another' : 'selected'}.en-gb.html${url.search}` }); response.end(); return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const firstRoom = `<tr><td rowspan="${sharedRoom ? 2 : 1}"><div data-testid="room-name">Double room</div><div>${wording}: 2 adults</div>${maxAdults}</td>${rateCell('double_flexible', 450, 'Free cancellation')}</tr>`;
      const alternatives = sharedRoom ? `<tr>${rateCell('double_nonrefundable', 400, 'Non-refundable')}</tr><tr><td><div data-testid="room-name">Single room</div></td>${rateCell('single_flexible', 100, 'Free cancellation')}</tr>` : '';
      response.end(`<h1>Selected Hotel</h1>${ratingMarkup}<input type="hidden" name="checkin" value="2026-10-20"><input type="hidden" name="checkout" value="2026-10-23"><input type="hidden" name="interval" value="3"><input type="hidden" name="room1" value="A,A"><table><thead><tr><th>Price for 3 nights</th></tr></thead><tbody>${firstRoom}${alternatives}</tbody></table>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing provider fixture');
    boundary.origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => { changed = false; wording = 'Sleeps'; sharedRoom = false; ratingMarkup = aggregateScore('9.3'); maxAdults = ''; });
  afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
  const search: HotelSearch = { sourceUrl: 'https://www.booking.com/hotel/gb/selected.html', destination: 'Selected Hotel', checkIn: '2026-10-20', checkOut: '2026-10-23', dateMode: 'fixed', flexibility: 0, minNights: 3, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'GBP', sources: ['booking'], filters: DEFAULT_HOTEL_FILTERS };
  it('accepts a language redirect and returns verified rates for the selected property', async () => {
    const offers = await searchHotelSource(search, search, 'booking');
    expect(offers).toEqual([expect.objectContaining({ propertyId: 'booking:/hotel/gb/selected.html', totalPrice: 450, currency: 'GBP', roomName: 'Double room', taxesIncluded: true, occupancyVerified: true })]);
  }, 20000);
  it('rejects a redirect to another hotel without returning its rates', async () => {
    changed = true;
    await expect(searchHotelSource(search, search, 'booking')).rejects.toThrow(/changed.*property/);
  }, 20000);
  it.each(['Sleeps', 'Guests'])('keeps shared-cell %s occupancy for both rates and resets it for the next room', async phrase => {
    wording = phrase;
    sharedRoom = true;
    const offers = await searchHotelSource(search, search, 'booking');
    expect(offers.map(offer => ({ room: offer.roomName, price: offer.totalPrice, refundable: offer.refundable }))).toEqual([
      { room: 'Double room', price: 400, refundable: false },
      { room: 'Double room', price: 450, refundable: true },
    ]);
  }, 20000);
  it('honors the explicit adult limit when the occupancy phrase advertises more adults', async () => {
    wording = 'Guests';
    maxAdults = '<span title="Max adults: 1"></span>';
    await expect(searchHotelSource(search, search, 'booking')).rejects.toThrow(/every requested room/);
  }, 20000);
  it('filters on the selected hotel aggregate instead of hidden recommendations or the Staff score', async () => {
    ratingMarkup = `<aside hidden><span aria-label="Scored 9.9">9.9</span></aside><aside><div data-testid="review-score-component"><span aria-label="Scored 9.8">Scored 9.8</span></div></aside>${aggregateScore('9.3')}`;
    const offers = await searchHotelSource(search, search, 'booking');
    expect(offers).toEqual([expect.objectContaining({ rating: 9.3 })]);
    expect(offers.filter(offer => matchesHotelFilters(offer, { ...search, filters: { ...search.filters, minRating: 9.5 } }))).toEqual([]);
    expect(offers.filter(offer => matchesHotelFilters(offer, { ...search, filters: { ...search.filters, minRating: 9 } }))).toEqual(offers);
  }, 20000);
  it('reads a Scored aria-label inside the property aggregate component', async () => {
    ratingMarkup = '<div id="reviewFloater"><div data-testid="review-score-right-component"><span aria-label="Scored 8.6 ">8.6</span></div><span aria-label="Scored 9.7">Staff</span></div>';
    expect(await searchHotelSource(search, search, 'booking')).toEqual([expect.objectContaining({ rating: 8.6 })]);
  }, 20000);
  it('accepts agreeing copies of the aggregate rating', async () => {
    ratingMarkup = `${aggregateScore('9.3')}<div data-capla-component-boundary="b-property-web-property-page/PropertyReviewScoreRight"><div data-testid="review-score-right-component">Rated: Superb 9.3, based on 758 reviews</div></div>`;
    expect(await searchHotelSource(search, search, 'booking')).toEqual([expect.objectContaining({ rating: 9.3 })]);
  }, 20000);
  it('ignores a hidden summary before the visible aggregate summary', async () => {
    ratingMarkup = aggregateScore('9.3').replace('<div>9.3</div>', '<span aria-hidden="true">Rated: Superb 9.9, based on 758 reviews</span><div>9.3</div>');
    expect(await searchHotelSource(search, search, 'booking')).toEqual([expect.objectContaining({ rating: 9.3 })]);
  }, 20000);
  it.each([
    { name: 'missing', markup: '<div id="reviewFloater"><span aria-label="Scored 9.7">Staff</span></div>' },
    { name: 'hidden', markup: `<div hidden>${aggregateScore('9.9')}</div>` },
    { name: 'aria-hidden', markup: `<div aria-hidden="true">${aggregateScore('9.9')}</div>` },
    { name: 'aria-hidden descendant', markup: '<div id="reviewFloater"><div data-testid="review-score-right-component"><span aria-hidden="true">Rated: Superb 9.9, based on 758 reviews</span></div></div>' },
    { name: 'transparent descendant', markup: '<div id="reviewFloater"><div data-testid="review-score-right-component"><span style="opacity:0">Rated: Superb 9.9, based on 758 reviews</span></div></div>' },
    { name: 'conflicting', markup: aggregateScore('9.6', '9.3') },
    { name: 'out-of-range', markup: aggregateScore('12') },
  ])('leaves the $name aggregate unverified and rejects minimum-rating filters', async ({ markup }) => {
    ratingMarkup = `${markup}<aside>Scored 9.9</aside>`;
    const offers = await searchHotelSource(search, search, 'booking');
    expect(offers).toEqual([expect.objectContaining({ rating: null })]);
    expect(offers.filter(offer => matchesHotelFilters(offer, { ...search, filters: { ...search.filters, minRating: 8 } }))).toEqual([]);
  }, 20000);
});
