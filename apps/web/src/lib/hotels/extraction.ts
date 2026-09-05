import type { HotelSearch, HotelSource, HotelStay } from './types';
import { googleSelectedDates } from './google';

export interface HotelPageCapture {
  url: string;
  text: string;
  controls: string;
  links: { text: string; url: string; seller?: string }[];
  images: { alt: string; url: string }[];
  propertyName?: string;
  address?: string;
  totalPriceBasis?: string;
  starsLabel?: string;
  rates?: { id: string; text: string; roomName: string; occupancy?: string; available?: number }[];
}


export function verifyHotelContext(capture: HotelPageCapture, search: HotelSearch, stay: HotelStay, source: HotelSource): void {
  for (const value of [stay.checkIn, stay.checkOut]) {
    const date = new Date(`${value}T12:00:00Z`);
    const month = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    const day = date.getUTCDate();
    const datePattern = new RegExp(`(?:${month}\\s+${day}\\b|\\b${day}\\s+${month})`, 'i');
    if (!capture.controls.includes(value) && !datePattern.test(capture.controls)) throw new Error('Displayed hotel dates do not match the requested stay');
  }
  if (source === 'booking') {
    if (!capture.controls.includes(`checkin=${stay.checkIn}`)) throw new Error('Booking.com did not verify the check-in year');
    const nights = Number(capture.controls.match(/\binterval=(\d+)/)?.[1]);
    if (!nights || new Date(Date.parse(stay.checkIn) + nights * 86400000).toISOString().slice(0, 10) !== stay.checkOut) throw new Error('Booking.com did not verify the checkout date and year');
    const rooms = [...capture.controls.matchAll(/\broom(\d+)=([A\d,]+)/g)].map(match => ({ index: Number(match[1]), guests: match[2]! }));
    if (rooms.length) {
      for (const [index, room] of search.rooms.entries()) {
        const actual = rooms.find(r => r.index === index + 1)?.guests.split(',') ?? [];
        if (actual.filter(g => g === 'A').length !== room.adults || actual.filter(g => g !== 'A').map(Number).sort().join(',') !== [...room.children].sort().join(',')) throw new Error('Provider changed the room allocation');
      }
      if (rooms.length !== search.rooms.length) throw new Error('Provider changed the room count');
      return;
    }
    const adults = search.rooms.reduce((n, r) => n + r.adults, 0);
    if (search.rooms.length !== 1 || search.rooms[0]!.children.length || !new RegExp(`${adults} adults?\\s*·\\s*0 children\\s*·\\s*1 room`).test(capture.controls)) throw new Error('Provider did not verify individual room allocation');
    return;
  }
  if (search.rooms.length !== 1) throw new Error('Google Hotels did not verify individual room allocation');
  const dates = googleSelectedDates(capture.url);
  if (dates[0] !== stay.checkIn || dates[1] !== stay.checkOut) throw new Error('Google Hotels did not verify the selected date years and order');
  const room = search.rooms[0]!;
  const adults = capture.controls.match(/Remove adult(\d+)\1Add adult/)?.[1];
  const children = capture.controls.match(/Remove child(\d+)\1Add child/)?.[1];
  if (Number(adults ?? -1) !== room.adults || Number(children ?? -1) !== room.children.length) throw new Error('Google Hotels did not verify the selected guest counts');
  const ages = [...capture.controls.matchAll(/(?:Age|age)\s*[:=]?\s*(\d+)\b/g)].map(match => Number(match[1])).sort();
  if (room.children.length && ages.join(',') !== [...room.children].sort().join(',')) throw new Error('Google Hotels did not verify child ages');
}
