import { assertValidIataCode, isoDate, type FlightSearchParams } from './navigate';

type TripTypeEnc = {
  oneWayKey?: string;
  oneWayValue?: string;
  roundTripKey?: string;
  roundTripValue?: string;
};

type AirlineSpec = {
  base: string;
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  passengers?: { key: string; value: string };
  cabin?: { key: string; map: Record<string, string> };
  currency?: string;
  tripType?: TripTypeEnc;
  extra?: Record<string, string>;
  customBuilder?: (p: FlightSearchParams, oneWay: boolean) => URL;
};

function cabinValue(p: FlightSearchParams, map: Record<string, string>): string {
  return map[p.cabinClass ?? 'economy'] ?? map.economy ?? '';
}

function buildFromSpec(spec: AirlineSpec, p: FlightSearchParams): string {
  assertValidIataCode(p.origin, 'origin');
  assertValidIataCode(p.destination, 'destination');

  const oneWay = p.tripType === 'one_way';

  if (spec.customBuilder) {
    return spec.customBuilder(p, oneWay).toString();
  }

  const url = new URL(spec.base);
  url.searchParams.set(spec.origin, p.origin);
  url.searchParams.set(spec.destination, p.destination);
  url.searchParams.set(spec.departureDate, isoDate(p.dateFrom));
  if (spec.passengers) url.searchParams.set(spec.passengers.key, spec.passengers.value);
  if (spec.cabin) url.searchParams.set(spec.cabin.key, cabinValue(p, spec.cabin.map));
  if (spec.currency) url.searchParams.set(spec.currency, p.currency ?? 'USD');
  if (spec.extra) {
    for (const [k, v] of Object.entries(spec.extra)) url.searchParams.set(k, v);
  }
  if (oneWay) {
    if (spec.tripType?.oneWayKey && spec.tripType.oneWayValue !== undefined) {
      url.searchParams.set(spec.tripType.oneWayKey, spec.tripType.oneWayValue);
    }
  } else {
    if (spec.returnDate) url.searchParams.set(spec.returnDate, isoDate(p.dateTo));
    if (spec.tripType?.roundTripKey && spec.tripType.roundTripValue !== undefined) {
      url.searchParams.set(spec.tripType.roundTripKey, spec.tripType.roundTripValue);
    }
  }
  return url.toString();
}

const AIRLINE_URL_SPECS: Record<string, AirlineSpec> = {
  // Americas
  southwest: {
    base: 'https://www.southwest.com/air/booking/select.html',
    origin: 'originationAirportCode',
    destination: 'destinationAirportCode',
    departureDate: 'departureDate',
    returnDate: 'returnDate',
    passengers: { key: 'adultPassengersCount', value: '1' },
    tripType: {
      oneWayKey: 'tripType',
      oneWayValue: 'oneway',
      roundTripKey: 'tripType',
      roundTripValue: 'roundtrip',
    },
  },

  jetblue: {
    base: 'https://www.jetblue.com/booking/flights',
    origin: 'from',
    destination: 'to',
    departureDate: 'depart',
    returnDate: 'return',
    passengers: { key: 'pax', value: '1' },
    extra: { fare: 'lowest' },
  },

  delta: {
    base: 'https://www.delta.com/flight-search/search',
    origin: 'from',
    destination: 'to',
    departureDate: 'departureDate',
    returnDate: 'returnDate',
    passengers: { key: 'paxCount', value: '1' },
    cabin: {
      key: 'cabinClass',
      map: { economy: 'MAIN', premium_economy: 'PREMIUM_ECONOMY', business: 'BUSINESS', first: 'FIRST' },
    },
    extra: { cacheKeySuffix: 'a', action: 'findFlights' },
    tripType: {
      oneWayKey: 'tripType',
      oneWayValue: 'ONE_WAY',
      roundTripKey: 'tripType',
      roundTripValue: 'ROUND_TRIP',
    },
  },

  united: {
    // Preserves the original path-based booking URL
    // (https://www.united.com/en-us/flights-from-X-to-Y) which depends on
    // the IATA codes being interpolated into the path, so this airline uses
    // a customBuilder rather than the AirlineSpec query-string flow.
    base: 'https://www.united.com',
    origin: '__path',
    destination: '__path',
    departureDate: 'departure',
    customBuilder: (p, oneWay) => {
      assertValidIataCode(p.origin, 'origin');
      assertValidIataCode(p.destination, 'destination');
      const url = new URL(`https://www.united.com/en-us/flights-from-${p.origin}-to-${p.destination}`);
      url.searchParams.set('departure', isoDate(p.dateFrom));
      if (!oneWay) url.searchParams.set('return', isoDate(p.dateTo));
      url.searchParams.set('passengers', '1');
      const cabinMapper: Record<string, string> = {
        economy: 'economy',
        premium_economy: 'premium-economy',
        business: 'business',
        first: 'first',
      };
      url.searchParams.set('cabin', cabinMapper[p.cabinClass ?? 'economy'] ?? 'economy');
      return url;
    },
  },

  american: {
    base: 'https://www.aa.com/booking/find-flights',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departDate',
    returnDate: 'returnDate',
    passengers: { key: 'pax', value: '1' },
    cabin: {
      key: 'cabin',
      map: { economy: 'ECONOMY', premium_economy: 'PREMIUM_ECONOMY', business: 'BUSINESS', first: 'FIRST' },
    },
    tripType: {
      oneWayKey: 'type',
      oneWayValue: 'oneWay',
      roundTripKey: 'type',
      roundTripValue: 'roundTrip',
    },
  },

  avianca: {
    base: 'https://www.avianca.com/en/booking/select-flights/',
    origin: 'origin1',
    destination: 'destination1',
    departureDate: 'departure1',
    customBuilder: (p, oneWay) => {
      assertValidIataCode(p.origin, 'origin');
      assertValidIataCode(p.destination, 'destination');
      const url = new URL('https://www.avianca.com/en/booking/select-flights/');
      url.searchParams.set('origin1', p.origin);
      url.searchParams.set('destination1', p.destination);
      url.searchParams.set('departure1', isoDate(p.dateFrom));
      if (!oneWay) {
        url.searchParams.set('origin2', p.destination);
        url.searchParams.set('destination2', p.origin);
        url.searchParams.set('departure2', isoDate(p.dateTo));
      }
      url.searchParams.set('adt', '1');
      url.searchParams.set('tng', '0');
      url.searchParams.set('chd', '0');
      url.searchParams.set('inf', '0');
      url.searchParams.set('currency', p.currency ?? 'USD');
      return url;
    },
  },

  latam: {
    base: 'https://www.latamairlines.com/us/en/booking',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'outbound',
    returnDate: 'inbound',
    passengers: { key: 'adt', value: '1' },
    extra: { cabin: 'Y' },
  },

  copa: {
    base: 'https://www.copaair.com/en-us/flight-offers/',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departureDate',
    returnDate: 'returnDate',
    passengers: { key: 'adults', value: '1' },
  },

  aeromexico: {
    base: 'https://www.aeromexico.com/en-us/booking',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departure',
    returnDate: 'return',
    passengers: { key: 'passengers', value: '1' },
  },

  // Europe
  ryanair: {
    base: 'https://www.ryanair.com/gb/en/trip/flights/select',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'dateOut',
    returnDate: 'dateIn',
    passengers: { key: 'adults', value: '1' },
  },

  easyjet: {
    base: 'https://www.easyjet.com/en/booking/select-flight',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'outboundDate',
    returnDate: 'inboundDate',
    passengers: { key: 'adults', value: '1' },
  },

  vueling: {
    base: 'https://www.vueling.com/en/booking/select',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'outbound',
    returnDate: 'inbound',
    passengers: { key: 'adults', value: '1' },
  },

  lufthansa: {
    base: 'https://www.lufthansa.com/us/en/flight-search',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'outbound',
    returnDate: 'inbound',
    passengers: { key: 'pax', value: '1' },
    cabin: {
      key: 'cabin',
      map: { economy: 'eco', premium_economy: 'pre', business: 'bus', first: 'fir' },
    },
  },

  'british airways': {
    base: 'https://www.britishairways.com/travel/book/public/en_us',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departureDate',
    returnDate: 'returnDate',
    passengers: { key: 'adults', value: '1' },
    cabin: {
      key: 'cabin',
      map: { economy: 'M', premium_economy: 'W', business: 'C', first: 'F' },
    },
  },

  'air france': {
    base: 'https://www.airfrance.us/search/offer',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'outboundDate',
    returnDate: 'inboundDate',
    passengers: { key: 'pax', value: '1' },
    cabin: {
      key: 'cabinClass',
      map: { economy: 'ECONOMY', premium_economy: 'PREMIUM', business: 'BUSINESS', first: 'FIRST' },
    },
  },

  klm: {
    base: 'https://www.klm.us/search/offer',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'outboundDate',
    returnDate: 'inboundDate',
    passengers: { key: 'pax', value: '1' },
  },

  iberia: {
    base: 'https://www.iberia.com/us/flights/',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departure',
    returnDate: 'return',
    passengers: { key: 'adults', value: '1' },
    extra: { market: 'US', language: 'en' },
  },

  'turkish airlines': {
    base: 'https://www.turkishairlines.com/en-us/flights/',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departureDate',
    returnDate: 'returnDate',
    passengers: { key: 'adult', value: '1' },
  },

  // Middle East and Asia
  emirates: {
    base: 'https://www.emirates.com/us/english/book/flight-search/',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departDate',
    returnDate: 'returnDate',
    passengers: { key: 'pax', value: '1' },
    cabin: {
      key: 'cabin',
      map: { economy: 'economy', premium_economy: 'economy', business: 'business', first: 'first' },
    },
  },

  'qatar airways': {
    base: 'https://www.qatarairways.com/en/booking/book-a-flight.html',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departDate',
    returnDate: 'returnDate',
    passengers: { key: 'adults', value: '1' },
  },

  etihad: {
    base: 'https://www.etihad.com/en-us/fly-etihad/book-a-flight',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departureDate',
    returnDate: 'returnDate',
    passengers: { key: 'pax', value: '1' },
  },

  'singapore airlines': {
    base: 'https://www.singaporeair.com/en_UK/plan-and-book/official-site-background/',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departureDate',
    returnDate: 'returnDate',
    passengers: { key: 'adult', value: '1' },
    cabin: {
      key: 'cabinClass',
      map: { economy: 'Y', premium_economy: 'S', business: 'J', first: 'F' },
    },
  },

  'cathay pacific': {
    base: 'https://www.cathaypacific.com/cx/en_US/book-a-trip/flight-search.html',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departDate',
    returnDate: 'returnDate',
    passengers: { key: 'adults', value: '1' },
  },

  // Oceania
  qantas: {
    base: 'https://www.qantas.com/au/en/booking/flight-search.html',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departureDate',
    returnDate: 'returnDate',
    passengers: { key: 'adults', value: '1' },
  },

  // Africa
  'ethiopian airlines': {
    base: 'https://www.ethiopianairlines.com/booking/book-a-flight',
    origin: 'origin',
    destination: 'destination',
    departureDate: 'departureDate',
    returnDate: 'returnDate',
    passengers: { key: 'adults', value: '1' },
  },
};

const ALIASES: Record<string, string> = {
  aa: 'american',
  'american airlines': 'american',
  ua: 'united',
  'united airlines': 'united',
  dl: 'delta',
  'delta air lines': 'delta',
  b6: 'jetblue',
  wn: 'southwest',
  'southwest airlines': 'southwest',
  ba: 'british airways',
  af: 'air france',
  lh: 'lufthansa',
  ek: 'emirates',
  qr: 'qatar airways',
  sq: 'singapore airlines',
  cx: 'cathay pacific',
  qf: 'qantas',
  ey: 'etihad',
  tk: 'turkish airlines',
  av: 'avianca',
  la: 'latam',
  cm: 'copa',
  am: 'aeromexico',
  fr: 'ryanair',
  u2: 'easyjet',
  vy: 'vueling',
  ib: 'iberia',
  et: 'ethiopian airlines',
  ethiopian: 'ethiopian airlines',
};

function normalizeAirline(name: string): string {
  const lower = name.toLowerCase().trim();
  return ALIASES[lower] ?? lower;
}

export function getAirlineUrl(airlineName: string, params: FlightSearchParams): string | null {
  const normalized = normalizeAirline(airlineName);
  const spec = AIRLINE_URL_SPECS[normalized];
  return spec ? buildFromSpec(spec, params) : null;
}

export function isKnownAirline(airlineName: string): boolean {
  return normalizeAirline(airlineName) in AIRLINE_URL_SPECS;
}

export function getKnownAirlines(): string[] {
  return Object.keys(AIRLINE_URL_SPECS);
}
