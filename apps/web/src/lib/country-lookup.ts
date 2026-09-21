import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { Reader, type CountryResponse } from 'mmdb-lib';

let database: Reader<CountryResponse> | undefined;

function countryDatabase(): Reader<CountryResponse> {
  if (database) return database;
  const packageDirectory = dirname(
    require.resolve('@ip-location-db/geolite2-country-mmdb/package.json'),
  );
  const path = join(packageDirectory, 'geolite2-country.mmdb');
  database = new Reader<CountryResponse>(readFileSync(path));
  return database;
}

export function lookupCountry(ip: string): string | null {
  if (!isIP(ip)) return null;
  const result: unknown = countryDatabase().get(ip);
  if (!result || typeof result !== 'object' || !('country_code' in result))
    return null;
  const country = result.country_code;
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country)
    ? country
    : null;
}
