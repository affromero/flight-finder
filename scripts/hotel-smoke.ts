import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureHotelSource, searchHotelSource } from '../apps/web/src/lib/hotels/providers';
import { DEFAULT_HOTEL_FILTERS, type HotelSearch, type HotelSource } from '../apps/web/src/lib/hotels/types';
import { extractBookingOffers } from '../apps/web/src/lib/hotels/booking-extraction';
import { extractGoogleOffers } from '../apps/web/src/lib/hotels/google-extraction';
import type { HotelPageCapture } from '../apps/web/src/lib/hotels/extraction';

async function main() {
const source = process.argv[2] as HotelSource;
if (!['booking', 'google_hotels'].includes(source)) throw new Error('Usage: tsx scripts/hotel-smoke.ts booking|google_hotels [--extract]');
const checkIn = process.argv.find(arg => arg.startsWith('--checkin='))?.slice('--checkin='.length) ?? new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
const checkOut = process.argv.find(arg => arg.startsWith('--checkout='))?.slice('--checkout='.length) ?? new Date(Date.now() + 48 * 86400000).toISOString().slice(0, 10);
const search: HotelSearch = {
  destination: 'London', dateMode: 'fixed', checkIn, checkOut, flexibility: 0,
  minNights: 3, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'USD',
  sources: [source], filters: DEFAULT_HOTEL_FILTERS,
};
const rooms = process.argv.find(arg => arg.startsWith('--rooms='))?.slice('--rooms='.length);
if (rooms) search.rooms = JSON.parse(rooms) as HotelSearch['rooms'];
const stay = { checkIn, checkOut };
const propertyUrl = process.argv.find(arg => arg.startsWith('--property='))?.slice('--property='.length);
const selection = propertyUrl ? { propertyId: '', source, hotelName: search.destination, propertyUrl, roomName: null, rateName: null, seller: '', refundable: null, breakfast: null } : undefined;
const replay = process.argv.find(arg => arg.startsWith('--replay='))?.slice('--replay='.length);
if (replay) {
  const capture = JSON.parse(await readFile(replay, 'utf8')) as HotelPageCapture;
  console.log(JSON.stringify(source === 'booking' ? extractBookingOffers(capture, search, stay) : extractGoogleOffers(capture, search, stay), null, 2));
  return;
}
if (process.argv.includes('--extract')) {
  const directory = resolve('/tmp', `flight-finder-hotel-smoke-${Date.now()}`);
  await mkdir(directory);
  const capture = selection ? await captureHotelSource(search, stay, source, selection) : null;
  if (capture) await writeFile(resolve(directory, `${source}.json`), JSON.stringify(capture, null, 2));
  console.log(JSON.stringify({ source, directory }));
  const offers = capture ? (source === 'booking' ? extractBookingOffers(capture, search, stay) : extractGoogleOffers(capture, search, stay)) : await searchHotelSource(search, stay, source);
  if (!offers.length) throw new Error('Live search returned no offers');
  await writeFile(resolve(directory, 'offers.json'), JSON.stringify(offers, null, 2));
  console.log(JSON.stringify({ count: offers.length, first: offers[0], directory }, null, 2));
} else {
  const capture = await captureHotelSource(search, stay, source, selection);
  const directory = resolve('/tmp', `flight-finder-hotel-smoke-${Date.now()}`);
  await mkdir(directory);
  await writeFile(resolve(directory, `${source}.json`), JSON.stringify(capture, null, 2));
  console.log(JSON.stringify({ source, directory, characters: capture.text.length, controls: capture.controls, excerpt: capture.text.slice(0, 3000) }));
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
