export const ALL_AGGREGATORS = ['google_flights', 'airline_direct', 'skyscanner', 'kayak'] as const;

export type Aggregator = (typeof ALL_AGGREGATORS)[number];

export const AGGREGATOR_LABEL: Record<Aggregator, string> = {
  google_flights: 'Google Flights',
  airline_direct: 'Airline direct',
  skyscanner: 'Skyscanner',
  kayak: 'Kayak',
};

export const EXPERIMENTAL_AGGREGATORS = new Set<Aggregator>(['skyscanner', 'kayak']);
