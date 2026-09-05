import type { Page } from 'playwright';
import type { HotelSearch, HotelSelection, HotelStay } from './types';

/** Read the date messages from Google's selected-search protobuf URL state. */
export function googleSelectedDates(value: string): string[] {
  const encoded = new URL(value).searchParams.get('ts');
  if (!encoded) return [];
  const dates: string[] = [];
  const visit = (bytes: Uint8Array, depth: number): void => {
    if (depth > 8) return;
    let offset = 0;
    const fields: Record<number, number> = {};
    const integer = () => {
      let value = 0;
      for (let shift = 0; shift < 35 && offset < bytes.length; shift += 7) {
        const byte = bytes[offset++]!;
        value += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) return value;
      }
      return -1;
    };
    while (offset < bytes.length) {
      const tag = integer();
      if (tag <= 0) return;
      const wire = tag & 7;
      if (wire === 0) { fields[tag >> 3] = integer(); continue; }
      if (wire !== 2) return;
      const length = integer();
      if (length < 0 || offset + length > bytes.length) return;
      visit(bytes.slice(offset, offset + length), depth + 1);
      offset += length;
    }
    const year = fields[1]; const month = fields[2]; const day = fields[3];
    if (year && year >= 2000 && year <= 2200 && month && month <= 12 && day && day <= 31) dates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  };
  visit(Buffer.from(encoded, 'base64url'), 0);
  return dates;
}

function replaceSelectedStay(encoded: string, stay: HotelStay): string {
  const dates = [stay.checkIn, stay.checkOut];
  let dateIndex = 0;
  const integer = (value: number): number[] => {
    const bytes: number[] = [];
    do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
    return bytes;
  };
  const rewrite = (bytes: Uint8Array, depth: number): Uint8Array => {
    if (depth > 8) return bytes;
    let offset = 0;
    const read = () => {
      let value = 0;
      for (let shift = 0; shift < 35 && offset < bytes.length; shift += 7) {
        const byte = bytes[offset++]!; value += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) return value;
      }
      return -1;
    };
    const fields: { tag: number; value: number | Uint8Array }[] = [];
    while (offset < bytes.length) {
      const tag = read();
      if (tag <= 0) return bytes;
      if ((tag & 7) === 0) { const value = read(); if (value < 0) return bytes; fields.push({ tag, value }); continue; }
      if ((tag & 7) !== 2) return bytes;
      const length = read();
      if (length < 0 || offset + length > bytes.length) return bytes;
      fields.push({ tag, value: bytes.slice(offset, offset + length) }); offset += length;
    }
    const values = Object.fromEntries(fields.filter(field => typeof field.value === 'number').map(field => [field.tag >> 3, field.value])) as Record<number, number>;
    if (values[1]! >= 2000 && values[1]! <= 2200 && values[2]! > 0 && values[2]! <= 12 && values[3]! > 0 && values[3]! <= 31 && dateIndex < 2) {
      const date = dates[dateIndex++]!.split('-').map(Number);
      for (const field of fields) if ((field.tag >> 3) <= 3) field.value = date[(field.tag >> 3) - 1]!;
    } else {
      const before = dateIndex;
      for (const field of fields) if (field.value instanceof Uint8Array) field.value = rewrite(field.value, depth + 1);
      if (dateIndex - before === 2) {
        const nights = fields.find(field => field.tag === 24);
        if (nights && typeof nights.value === 'number') nights.value = Math.round((Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000);
      }
    }
    return Uint8Array.from(fields.flatMap(field => typeof field.value === 'number' ? [...integer(field.tag), ...integer(field.value)] : [...integer(field.tag), ...integer(field.value.length), ...field.value]));
  };
  const result = rewrite(Buffer.from(encoded, 'base64url'), 0);
  if (dateIndex !== 2) throw new Error('Google Hotels saved date state is not supported');
  return Buffer.from(result).toString('base64url');
}

export function googleSearchUrl(search: HotelSearch, stay: HotelStay, selection?: HotelSelection): string {
  const url = new URL(selection?.propertyUrl ?? `https://www.google.com/travel/hotels/${encodeURIComponent(search.destination)}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'www.google.com' || !url.pathname.startsWith('/travel/')) throw new Error('Invalid Google Hotels property URL');
  const selectedState = url.searchParams.get('ts');
  if (selectedState) url.searchParams.set('ts', replaceSelectedStay(selectedState, stay));
  for (const key of ['ved', 'utm_campaign', 'utm_medium', 'utm_source']) url.searchParams.delete(key);
  if (url.pathname.includes('/entity/')) url.searchParams.delete('qs');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', 'gb');
  url.searchParams.set('curr', search.currency);
  const date = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  url.searchParams.set('q', `${selection?.hotelName ?? `hotels in ${search.destination}`} ${date(stay.checkIn)} to ${date(stay.checkOut)} ${search.rooms.map(r => `${r.adults} adults${r.children.length ? ` children ages ${r.children.join(',')}` : ''}`).join('; ')} ${search.rooms.length} rooms`);
  return url.href;
}

export async function selectGoogleTotal(page: Page): Promise<string> {
  const priceControl = page.getByRole('button', { name: /^Price displayed/ }).first();
  if (!await priceControl.count()) return '';
  await priceControl.click();
  await page.getByText('Stay total', { exact: true }).click({ timeout: 5000 });
  const basis = await page.getByText('Stay total', { exact: true }).evaluate(element => element.parentElement?.parentElement?.textContent ?? '');
  await page.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 5000 });
  return basis;
}
