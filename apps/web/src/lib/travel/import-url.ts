export type ImportKind = 'flights' | 'hotels' | 'cars';
export type ImportSource = 'google_flights' | 'google_hotels' | 'booking' | 'discovercars' | 'autoeurope';

/** Only selected, public product pages are eligible for import. */
export function travelImportUrl(raw: unknown, kind: ImportKind): { url: string; source: ImportSource } {
  if (typeof raw !== 'string' || raw.length > 16000 || !raw.trim()) throw new Error('Paste a selected booking link');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Paste a complete HTTPS booking link'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use a public HTTPS booking link without credentials');
  let source: ImportSource | undefined;
  if (kind === 'flights' && url.hostname === 'www.google.com' && url.pathname === '/travel/flights/booking' && url.searchParams.has('tfs')) source = 'google_flights';
  if (kind === 'hotels') {
    if (url.hostname === 'www.google.com' && /^\/travel\/hotels\/entity\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) source = 'google_hotels';
    if (['booking.com', 'www.booking.com'].includes(url.hostname) && /^\/hotel\/[a-z]{2}\/[\w.-]+\.html$/.test(url.pathname)) { source = 'booking'; url.hostname = 'www.booking.com'; }
  }
  if (kind === 'cars') {
    if (url.hostname === 'www.discovercars.com' && /^\/offer\/[0-9a-f-]{36}-[A-Za-z0-9]+$/i.test(url.pathname) && url.searchParams.has('sq')) source = 'discovercars';
    if (url.hostname === 'book.autoeurope.com' && url.pathname === '/en-us/options' && url.searchParams.get('rate_reference')) source = 'autoeurope';
  }
  if (!source) throw new Error(`This ${kind} link is not supported. Copy the selected product link from a supported provider, rather than a search, short link or reservation confirmation.`);
  for (const key of new Set(url.searchParams.keys())) if (key !== 'age' && url.searchParams.getAll(key).length > 1) throw new Error('The link contains conflicting repeated search parameters');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|client$|ved$)/.test(key)) url.searchParams.delete(key);
  if (source === 'booking') url.searchParams.delete('sid');
  return { url: url.href, source };
}

export function optionalImportUrl(raw: unknown, kind: ImportKind, sources: readonly string[]): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const imported = travelImportUrl(raw, kind);
  if (sources.length !== 1 || sources[0] !== imported.source) throw new Error('An imported selection must use only its original provider');
  return imported.url;
}
