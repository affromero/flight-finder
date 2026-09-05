import type { HotelSearch, HotelSelection, HotelStay } from './types';

export function bookingSearchUrl(search: HotelSearch, stay: HotelStay, selection?: HotelSelection): string {
  const url = new URL(selection?.propertyUrl ?? 'https://www.booking.com/searchresults.html');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'www.booking.com' || (selection && !/^\/hotel\/[a-z]{2}\/[\w.-]+\.html$/.test(url.pathname))) {
    throw new Error('Invalid Booking.com property URL');
  }
  url.search = '';
  url.searchParams.set('ss', search.destination);
  url.searchParams.set('checkin', stay.checkIn);
  url.searchParams.set('checkout', stay.checkOut);
  url.searchParams.set('group_adults', String(search.rooms.reduce((n, r) => n + r.adults, 0)));
  url.searchParams.set('no_rooms', String(search.rooms.length));
  const children = search.rooms.flatMap(r => r.children);
  url.searchParams.set('group_children', String(children.length));
  for (const age of children) url.searchParams.append('age', String(age));
  search.rooms.forEach((room, index) => url.searchParams.set(`room${index + 1}`, [...Array<string>(room.adults).fill('A'), ...room.children.map(String)].join(',')));
  url.searchParams.set('selected_currency', search.currency);
  url.searchParams.set('lang', 'en-gb');
  return url.href;
}
