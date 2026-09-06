/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HotelSearchExperience } from './HotelSearchExperience';
import { HotelTrackers } from './HotelTrackers';
import { HotelDetail } from './HotelDetail';
import { HotelOfferCard } from './HotelOfferCard';
import { TravelNav } from './TravelNav';
import type { HotelOffer, HotelSearch } from '@/lib/hotels/types';
import { hotelHistoryObservations, type HotelDetailView } from './client';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
const search: HotelSearch = { destination: 'London', dateMode: 'fixed', checkIn: '2027-10-15', checkOut: '2027-10-18', flexibility: 1, minNights: 1, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'USD', sources: ['google_hotels', 'booking'], filters: { maxTotal: null, refundable: false, breakfast: false, minStars: 0, minRating: 0, excludedSellers: [], amenities: [] } };
const offer: HotelOffer = { id: 'offer1', source: 'google_hotels', propertyId: 'hotel1', hotelName: 'Park Plaza', address: 'Westminster, London', imageUrl: null, propertyUrl: 'https://example.com/hotel', bookingUrl: 'https://example.com/book', seller: 'Booking.com', roomName: 'Double room', rateName: 'Flexible', totalPrice: 600, currency: 'USD', taxesIncluded: true, occupancyVerified: true, rooms: search.rooms, refundable: true, breakfast: null, stars: 4, rating: 8.5, amenities: {}, match: 'exact', checkIn: search.checkIn, checkOut: search.checkOut };
function detail(): HotelDetailView { return { tracker: { id: 'tracker1', hotelName: offer.hotelName, search, selection: { propertyId: offer.propertyId, source: offer.source, hotelName: offer.hotelName, propertyUrl: offer.propertyUrl, roomName: offer.roomName, rateName: offer.rateName, seller: offer.seller, refundable: offer.refundable, breakfast: offer.breakfast }, options: { mode: 'best', targetPrice: 650, notifyLows: true, allowApproximateAlerts: false, scrapeInterval: 3 }, active: true, createdAt: '2027-09-01T12:00:00Z', updatedAt: '2027-09-01T12:00:00Z', lastCheckedAt: null, lastError: null, latestPrice: null, currency: 'USD' }, snapshots: [], runs: [], notificationsConfigured: false }; }
function response(data: unknown, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } }); }
function fillSearch() { fireEvent.change(screen.getByLabelText('City or hotel name'), { target: { value: 'London' } }); fireEvent.change(screen.getByLabelText('Check-in'), { target: { value: '2027-10-15' } }); fireEvent.change(screen.getByLabelText('Check-out'), { target: { value: '2027-10-18' } }); }
beforeEach(() => { push.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Hotel search and tracking', () => {
  it('offers both travel sections from an account without marking either as the current page', () => {
    render(<TravelNav />);
    expect(screen.getByRole('link', { name: 'Flights' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Hotels' })).toHaveAttribute('href', '/hotels');
    expect(screen.getAllByRole('link').every(link => !link.hasAttribute('aria-current'))).toBe(true);
  });
  it.each(['flights', 'hotels'] as const)('marks only the active %s section as the current page', active => {
    render(<TravelNav active={active} />);
    expect(screen.getByRole('link', { current: 'page' })).toHaveAttribute('href', active === 'flights' ? '/' : '/hotels');
  });
  it('submits room allocation, child ages and filters without requiring a flight', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ id: 's1', status: 'unavailable', result: { offers: [], errors: [], completed: 2, total: 2 } })); vi.stubGlobal('fetch', fetcher);
    render(<HotelSearchExperience />); fillSearch();
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    fireEvent.change(screen.getAllByLabelText('Children')[1]!, { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Room 2, child 1: age'), { target: { value: '7' } });
    fireEvent.click(screen.getByText('Offer requirements'));
    fireEvent.click(screen.getByLabelText('Breakfast included'));
    fireEvent.click(screen.getByRole('button', { name: 'Search hotels' }));
    await screen.findByText(/No offers matched/);
    const submitted = JSON.parse(fetcher.mock.calls[0]![1].body as string) as HotelSearch;
    expect(submitted).toMatchObject({ destination: 'London', rooms: [{ adults: 2, children: [] }, { adults: 2, children: [7] }], filters: { breakfast: true } });
  });
  it('lets users review and edit parsed natural-language details before searching', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ search })); vi.stubGlobal('fetch', fetcher);
    render(<HotelSearchExperience />);
    fireEvent.change(screen.getByLabelText(/Describe your stay/), { target: { value: 'Three nights in London' } }); fireEvent.click(screen.getByRole('button', { name: 'Fill in details' }));
    await waitFor(() => expect(screen.getByLabelText('City or hotel name')).toHaveValue('London'));
    expect(screen.getByLabelText('Check-in')).toHaveValue('2027-10-15');
    fireEvent.change(screen.getByLabelText('City or hotel name'), { target: { value: 'Oxford' } });
    expect(screen.getByLabelText('City or hotel name')).toHaveValue('Oxford');
    expect(fetcher.mock.calls.every(([url]) => url === '/api/hotels/parse')).toBe(true);
  });
  it('shows provider failures alongside usable results and saves the chosen alert settings', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => url === '/api/hotels/search' ? response({ id: 's1', status: 'partial', result: { offers: [offer], errors: [{ source: 'booking', checkIn: search.checkIn, checkOut: search.checkOut, message: 'Provider blocked' }], completed: 1, total: 2 } }) : response({ tracker: { id: 'tracker1' } })); vi.stubGlobal('fetch', fetcher);
    render(<HotelSearchExperience />); fillSearch(); fireEvent.click(screen.getByRole('button', { name: 'Search hotels' }));
    await screen.findByRole('heading', { name: 'Park Plaza' }); expect(screen.getByRole('alert')).toHaveTextContent('Provider blocked');
    fireEvent.change(screen.getByLabelText('Offer matching'), { target: { value: 'room' } }); fireEvent.change(screen.getByLabelText('Alert below total price'), { target: { value: '550' } });
    fireEvent.click(screen.getByRole('button', { name: 'Track this hotel' })); await waitFor(() => expect(push).toHaveBeenCalledWith('/hotels/tracker1'));
    const call = fetcher.mock.calls.find(([url]) => url === '/api/hotels'); expect(JSON.parse(call![1].body as string)).toMatchObject({ searchId: 's1', offerId: 'offer1', mode: 'room', targetPrice: 550, allowApproximateAlerts: false, scrapeInterval: 3 });
  });
  it('surfaces search failure and restores the search action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'Browser unavailable' }), { status: 503 })));
    render(<HotelSearchExperience />); fillSearch(); fireEvent.click(screen.getByRole('button', { name: 'Search hotels' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Browser unavailable'); expect(screen.getByRole('button', { name: 'Search hotels' })).toBeEnabled();
  });
  it('cancels a running search and allows another search', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => url === '/api/hotels/search' ? response({ id: 's1', status: 'running', result: null, error: null }) : response({ status: 'cancelled' })));
    render(<HotelSearchExperience />); fillSearch(); fireEvent.click(screen.getByRole('button', { name: 'Search hotels' })); fireEvent.click(await screen.findByRole('button', { name: 'Cancel search' }));
    await screen.findByText('Search cancelled.'); expect(screen.getByRole('button', { name: 'Search hotels' })).toBeEnabled();
  });
  it('disables searching when no provider is selected', () => { render(<HotelSearchExperience />); fireEvent.click(screen.getByLabelText('Google Hotels')); fireEvent.click(screen.getByLabelText('Booking.com')); expect(screen.getByRole('button', { name: 'Search hotels' })).toBeDisabled(); });
  it('polls an asynchronous search until offers are available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => url === '/api/hotels/search' ? response({ id: 's1', status: 'queued', result: null, error: null }) : response({ id: 's1', status: 'success', result: { offers: [offer], errors: [], completed: 2, total: 2 }, error: null })));
    render(<HotelSearchExperience />); fillSearch(); fireEvent.click(screen.getByRole('button', { name: 'Search hotels' }));
    await screen.findByText(/Checking providers/); await screen.findByRole('heading', { name: 'Park Plaza' }, { timeout: 3000 }); expect(screen.queryByRole('button', { name: 'Cancel search' })).not.toBeInTheDocument();
  });
  it('submits a flexible date window with the chosen stay length', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ id: 's1', status: 'unavailable', result: { offers: [], errors: [], completed: 1, total: 1 } })); vi.stubGlobal('fetch', fetcher);
    render(<HotelSearchExperience />); fillSearch(); fireEvent.change(screen.getByLabelText('Dates'), { target: { value: 'window' } });
    fireEvent.change(screen.getByLabelText('Latest departure'), { target: { value: '2027-10-20' } }); fireEvent.change(screen.getByLabelText('Minimum nights'), { target: { value: '2' } }); fireEvent.change(screen.getByLabelText('Maximum nights'), { target: { value: '2' } }); fireEvent.click(screen.getByRole('button', { name: 'Search hotels' }));
    await screen.findByText(/No offers matched/); expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toMatchObject({ dateMode: 'window', checkIn: '2027-10-15', checkOut: '2027-10-20', minNights: 2, maxNights: 2 });
  });
  it('shows progressive offers without allowing tracking until the search completes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => response({ id: 's1', status: url === '/api/hotels/search' ? 'running' : 'success', result: { offers: [offer], errors: [], completed: 1, total: 2 }, error: null })));
    render(<HotelSearchExperience />); fillSearch(); fireEvent.click(screen.getByRole('button', { name: 'Search hotels' }));
    expect(await screen.findByRole('button', { name: 'Track this hotel' })).toBeDisabled(); expect(screen.getByText(/1 of 2 checks complete/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Track this hotel' })).toBeEnabled(), { timeout: 3000 });
  });
  it('does not report no offers while a progressive search is still running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ id: 's1', status: 'running', result: { offers: [], errors: [], completed: 0, total: 2 }, error: null })));
    render(<HotelSearchExperience />); fillSearch(); fireEvent.click(screen.getByRole('button', { name: 'Search hotels' }));
    await screen.findByText(/0 of 2 checks complete/); expect(screen.queryByText(/No offers matched/)).not.toBeInTheDocument();
  });
  it('retains the running search after a status connection failure and resumes it on retry', async () => {
    let disconnected = true;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => { if (url === '/api/hotels/search') return response({ id: 's1', status: 'running', result: null, error: null }); if (disconnected) throw new Error('Connection lost'); return response({ id: 's1', status: 'success', result: { offers: [offer], errors: [], completed: 2, total: 2 }, error: null }); }));
    render(<HotelSearchExperience />); fillSearch(); fireEvent.click(screen.getByRole('button', { name: 'Search hotels' }));
    await screen.findByText(/Status updates interrupted/, {}, { timeout: 3000 }); expect(screen.getByRole('button', { name: 'Cancel search' })).toBeEnabled(); expect(screen.getByRole('button', { name: 'Searching…' })).toBeDisabled();
    disconnected = false; fireEvent.click(screen.getByRole('button', { name: 'Retry status updates' }));
    await screen.findByRole('heading', { name: 'Park Plaza' }, { timeout: 3000 }); expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Track this hotel' })).toBeEnabled();
  });
});

describe('Hotel offers and saved trackers', () => {
  it('distinguishes unknown breakfast and approximate matches and omits unsafe booking links', () => {
    render(<HotelOfferCard offer={{ ...offer, match: 'approximate', bookingUrl: 'javascript:alert(1)' }} busy={false} onTrack={() => undefined} />);
    expect(screen.getByText('Approximate match')).toBeInTheDocument(); expect(screen.getByText(/Breakfast included: Unknown/)).toBeInTheDocument(); expect(screen.queryByRole('link', { name: 'View offer' })).not.toBeInTheDocument();
  });
  it('lists saved hotel stays with status and a link to their history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ trackers: [{ ...detail().tracker, active: false, latestPrice: 600 }] })));
    render(<HotelTrackers />); const link = await screen.findByRole('link', { name: /Park Plaza/ }); expect(link).toHaveAttribute('href', '/hotels/tracker1'); expect(link).toHaveTextContent('Paused'); expect(screen.getByText('$600.00')).toBeInTheDocument();
  });
  it('shows a list loading error without presenting an empty list as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network disconnected'))); render(<HotelTrackers />); expect(await screen.findByRole('alert')).toHaveTextContent('Network disconnected'); expect(screen.queryByText(/No hotel trackers/)).not.toBeInTheDocument();
  });
  it('saves target changes and pauses a tracker through its management API', async () => {
    let current = detail(); const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => { if (init?.method === 'PATCH') { const change = JSON.parse(init.body as string) as { active?: boolean; targetPrice?: number }; current = { ...current, tracker: { ...current.tracker, active: change.active ?? current.tracker.active, options: { ...current.tracker.options, targetPrice: change.targetPrice ?? current.tracker.options.targetPrice } } }; return response({ tracker: current.tracker }); } return response(current); }); vi.stubGlobal('fetch', fetcher);
    render(<HotelDetail id="tracker1" />); await screen.findByRole('heading', { name: 'Park Plaza' });
    expect(screen.getByText(/Set up a notification channel/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Alert below total price'), { target: { value: '500' } }); fireEvent.click(screen.getByRole('button', { name: 'Save alert settings' })); await screen.findByText('Changes saved.');
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH' && JSON.parse(init.body as string).targetPrice === 500)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' })); await screen.findByRole('button', { name: 'Resume' }); expect(screen.getByRole('button', { name: 'Check prices now' })).toBeDisabled();
  });
  it('keeps actual dates and eligibility visible for observations excluded from the chart', async () => {
    const current = detail(); current.snapshots = [{ id: 'p1', runId: 'r1', scrapedAt: '2027-09-02T12:00:00Z', eligible: false, offer: { ...offer, match: 'approximate', checkIn: '2027-10-16', checkOut: '2027-10-19' } }]; vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(current)));
    render(<HotelDetail id="tracker1" />); const table = await screen.findByRole('table'); await waitFor(() => expect(within(table).getByText(/2027-10-16/)).toBeInTheDocument()); expect(within(table).getByText(/Not eligible for alerts/)).toBeInTheDocument(); expect(within(table).getByText('Double room')).toBeInTheDocument(); expect(within(table).getByText('Flexible')).toBeInTheDocument(); expect(within(table).getByText('Unknown')).toBeInTheDocument();
  });
  it('makes detailed history keyboard-focusable and explains sideways scrolling', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(detail())));
    render(<HotelDetail id="tracker1" />);
    const region = await screen.findByRole('region', { name: 'Detailed price history' });
    expect(within(region).getByRole('table')).toBeInTheDocument();
    expect(region).toHaveAccessibleDescription(/Scroll sideways.*arrow keys/);
    region.focus();
    expect(region).toHaveFocus();
  });
  it('requires confirmation before deleting a hotel and returns to search after deletion', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => init?.method === 'DELETE' ? response({ deleted: true }) : response(detail())); vi.stubGlobal('fetch', fetcher);
    render(<HotelDetail id="tracker1" />); fireEvent.click(await screen.findByRole('button', { name: 'Delete tracker' }));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Delete tracker' })); await waitFor(() => expect(push).toHaveBeenCalledWith('/hotels'));
  });
  it('allows an administrator to reassign a tracker to an existing account', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => url === '/api/admin/users' ? response({ users: [{ id: 'alice', username: 'alice', displayName: 'Alice' }] }) : init?.method === 'PATCH' ? response({ tracker: { ...detail().tracker, userId: 'alice' } }) : response(detail())); vi.stubGlobal('fetch', fetcher);
    render(<HotelDetail id="tracker1" canReassign />); await screen.findByRole('option', { name: 'Alice' }); fireEvent.change(screen.getByLabelText('Tracker owner'), { target: { value: 'alice' } }); fireEvent.click(screen.getByRole('button', { name: 'Reassign tracker' })); await screen.findByText('Changes saved.');
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH' && JSON.parse(init.body as string).userId === 'alice')).toBe(true);
  });
  it('does not expose owner reassignment to ordinary users', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(detail()))); render(<HotelDetail id="tracker1" />); await screen.findByRole('heading', { name: 'Park Plaza' }); expect(screen.queryByLabelText('Tracker owner')).not.toBeInTheDocument();
  });
  it('charts the lowest eligible offer per check in chronological order, retaining the winning stay dates', () => {
    const snapshots: HotelDetailView['snapshots'] = [
      { id: 'later', runId: 'r2', scrapedAt: '2027-09-02T12:00:00Z', eligible: true, offer: { ...offer, totalPrice: 550 } },
      { id: 'higher', runId: 'r1', scrapedAt: '2027-09-01T12:00:00Z', eligible: true, offer },
      { id: 'lowest', runId: 'r1', scrapedAt: '2027-09-01T12:00:01Z', eligible: true, offer: { ...offer, totalPrice: 500, checkIn: '2027-10-16' } },
      { id: 'ineligible', runId: 'r1', scrapedAt: '2027-09-01T12:00:02Z', eligible: false, offer: { ...offer, totalPrice: 300 } },
    ];
    expect(hotelHistoryObservations(snapshots).map((snapshot) => ({ price: snapshot.offer.totalPrice, checkIn: snapshot.offer.checkIn }))).toEqual([{ price: 500, checkIn: '2027-10-16' }, { price: 550, checkIn: '2027-10-15' }]);
  });
});
