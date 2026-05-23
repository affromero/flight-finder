import { EXTRACTION_PROVIDERS, CLI_PROVIDERS, LOCAL_PROVIDERS, type ExtractionUsage } from './ai-registry';
import { prisma } from '@/lib/prisma';
import { parseDurationToMinutes } from './duration';
import type { NavigationSource } from './navigate';
import { acquireProviderToken } from './rate-limit';

export interface PriceData {
  travelDate: string; // ISO date
  price: number;
  currency: string;
  airline: string;
  bookingUrl: string | null;
  stops: number;
  duration: string | null;
  departureTime: string | null; // e.g. "10:25 AM"
  arrivalTime: string | null; // e.g. "4:45 PM"
  seatsLeft: number | null; // e.g. 3 when "3 seats left" shown
  flightNumber: string | null; // e.g. "DL 345"
}

export interface QueryFilters {
  maxPrice: number | null;
  maxStops: number | null;
  maxDurationHours: number | null;
  preferredAirlines: string[];
  timePreference: string;
  cabinClass: string;
}

const DEFAULT_MAX_RESULTS = 10;

function buildSystemPrompt(filters: QueryFilters, maxResults: number, source: NavigationSource = 'google_flights', currency: string | null = null): string {
  const filterRules: string[] = [];

  if (filters.maxPrice) {
    filterRules.push(`- ONLY include flights priced at or below ${filters.maxPrice}`);
  }
  if (filters.maxStops !== null) {
    filterRules.push(
      filters.maxStops === 0
        ? '- ONLY include nonstop/direct flights'
        : `- ONLY include flights with ${filters.maxStops} stop(s) or fewer`
    );
  }
  if (filters.preferredAirlines.length > 0) {
    filterRules.push(`- ONLY include flights operated by: ${filters.preferredAirlines.join(', ')}`);
  }
  if (filters.timePreference !== 'any') {
    const timeMap: Record<string, string> = {
      morning: 'departing before 12:00 PM',
      afternoon: 'departing between 12:00 PM and 6:00 PM',
      evening: 'departing after 6:00 PM',
      redeye: 'departing after 10:00 PM (red-eye flights)',
    };
    filterRules.push(`- Prefer flights ${timeMap[filters.timePreference] ?? ''}`);
  }

  const filterSection = filterRules.length > 0
    ? `\nFiltering rules (STRICT — do not include flights that violate these):\n${filterRules.join('\n')}\n`
    : '';

  const sourceDesc = source === 'airline_direct'
    ? "an airline's booking/search results page"
    : 'a Google Flights search results page';

  const bookingUrlRule = source === 'airline_direct'
    ? '- For bookingUrl, use the search URL provided (the airline website URL)'
    : "- If you can't find a direct booking URL, construct one from the Google Flights URL";

  const currencyInstruction = currency
    ? `- Use "${currency}" as the currency code for all results`
    : `- Detect the currency from the page content (look for $, EUR, GBP, £, JPY, ¥ symbols or codes). Use the ISO 4217 code. If unclear, use "USD"`;

  return `You are a flight price data extractor. Given the visible text content from ${sourceDesc}, extract the best matching flight options.

Return ONLY valid JSON — an array of UP TO ${maxResults} objects with this exact shape:
[
  {
    "travelDate": "YYYY-MM-DD",
    "price": 623,
    "currency": "${currency || 'USD'}",
    "airline": "Delta",
    "bookingUrl": "https://...",
    "stops": 1,
    "duration": "11h 20m",
    "departureTime": "10:25 AM",
    "arrivalTime": "4:45 PM",
    "seatsLeft": 3,
    "flightNumber": "DL 345"
  }
]
${filterSection}
General rules:
- Return at most ${maxResults} results, sorted by price (cheapest first)
- Price must be a number (no $ sign, no commas)
- For round-trip searches, Google Flights shows the FULL round-trip price on each flight. Do NOT halve or double it — extract the price exactly as shown
${currencyInstruction}
${bookingUrlRule}
- stops: 0 for nonstop, 1 for 1 stop, etc.
- duration: human-readable format like "8h 30m"
- departureTime: the departure time as shown (e.g. "10:25 AM", "7:50 PM"). Use null if not visible
- arrivalTime: the arrival time as shown (e.g. "4:45 PM", "11:30 AM"). Use null if not visible
- seatsLeft: if the page shows "N seats left" or "N seats left at this price", extract the number. Use null if not shown
- flightNumber: extract the carrier code plus number when shown (e.g. "DL 345", "AA 1102", "TK 32"). Use null if only the airline name is visible without a number
- If the travel date is not clearly visible per result, use the search date provided
- Prefer variety: if multiple airlines are available, include at least one from each (up to the ${maxResults} limit)
- Return ONLY the JSON array, no markdown, no explanation
- If you cannot extract any flights, return an empty array []`;
}

export type ExtractionFailureReason =
  | 'page_not_loaded'
  | 'no_json_in_response'
  | 'empty_extraction'
  | 'all_filtered_out'
  | 'llm_error'
  | 'json_parse_error';

export interface ExtractionResult {
  prices: PriceData[];
  usage: ExtractionUsage;
  failureReason?: ExtractionFailureReason;
}

/**
 * Slim subset of ExtractionConfig that extractPrices needs. Allows callers
 * (preview-runner, run-scrape) to read the config once up front and pass
 * it through every per-attempt call, instead of extractPrices hitting the
 * DB on every attempt. Issue 65 audit finding A4.
 */
export interface ExtractionConfigOverride {
  provider: string;
  model: string;
  customBaseUrl: string | null;
  extractTimeoutSeconds : number;
}

export async function extractPrices(
  html: string,
  searchUrl: string,
  travelDateFallback: string,
  filters: QueryFilters = { maxPrice: null, maxStops: null, maxDurationHours: null, preferredAirlines: [], timePreference: 'any', cabinClass: 'economy' },
  maxResults: number = DEFAULT_MAX_RESULTS,
  resultsFound: boolean = true,
  source: NavigationSource = 'google_flights',
  currency: string | null = null,
  configOverride?: ExtractionConfigOverride
): Promise<ExtractionResult> {
  if (!resultsFound) {
    console.log(`[extract] skipped — page did not load results (source=${source})`);
    return { prices: [], usage: { inputTokens: 0, outputTokens: 0 }, failureReason: 'page_not_loaded' };
  }

  // When the caller already resolved the config (eg. preview-runner hoists
  // it once per preview), skip the DB read. Backwards compatible for the
  // /api/test/scrape endpoint and tests that pass minimal args.
  const config = configOverride
    ? { provider: configOverride.provider, model: configOverride.model, customBaseUrl: configOverride.customBaseUrl }
    : await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });

  const provider = config?.provider ?? 'anthropic';
  const model = config?.model ?? 'claude-haiku-4-5-20251001';
  const providerConfig = EXTRACTION_PROVIDERS[provider];

  if (!providerConfig) {
    throw new Error(`Unknown extraction provider: ${provider}`);
  }

  const isCliProvider = provider in CLI_PROVIDERS;
  const isLocalProvider = LOCAL_PROVIDERS.has(provider);
  const hasLocalEndpoint =
    (provider === 'openai' && (config?.customBaseUrl || process.env.OPENAI_BASE_URL)) ||
    isLocalProvider;
  const apiKey = isCliProvider ? '' : (providerConfig.envKey ? process.env[providerConfig.envKey] : '') ?? '';
  if (!apiKey && !isCliProvider && !hasLocalEndpoint) {
    throw new Error(`Missing API key: ${providerConfig.envKey}`);
  }

  console.log(`[extract] sending ${html.length} chars to ${provider}/${model}`);

  const userPrompt = `Search URL: ${searchUrl}
Default travel date (if not visible per result): ${travelDateFallback}

Page content:
${html}`;

  const systemPrompt = buildSystemPrompt(filters, maxResults, source, currency);
  // Block briefly when the rolling per minute window for this provider
  // is full. Audit finding D3: PREVIEW_CONCURRENCY=3 plus llm_error
  // retries can otherwise burst past free tier RPM caps and trip
  // additional retries in a feedback loop. acquireProviderToken is a
  // no-op for local and CLI providers.
  await acquireProviderToken(provider);
  let result;
  try {
    result = await providerConfig.extract(apiKey, model, systemPrompt, userPrompt, {
      baseUrl: config?.customBaseUrl ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract] FAIL llm_error provider=${provider} model=${model} err=${msg}`);
    return { prices: [], usage: { inputTokens: 0, outputTokens: 0 }, failureReason: 'llm_error' };
  }

  const jsonMatch = result.content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.log(`[extract] FAIL no_json_in_response — LLM returned no parseable JSON`);
    return { prices: [], usage: result.usage, failureReason: 'no_json_in_response' };
  }

  let raw: PriceData[];
  try {
    raw = JSON.parse(jsonMatch[0]) as PriceData[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const preview = jsonMatch[0].slice(0, 200);
    console.error(`[extract] FAIL json_parse_error length=${jsonMatch[0].length} err=${msg} preview=${preview}`);
    return { prices: [], usage: result.usage, failureReason: 'json_parse_error' };
  }

  if (raw.length === 0) {
    console.log(`[extract] FAIL empty_extraction — LLM returned [] (${result.usage.inputTokens} input tokens)`);
    return { prices: [], usage: result.usage, failureReason: 'empty_extraction' };
  }

  // Coerce null bookingUrl to empty string (LLMs frequently return null)
  for (const p of raw) {
    if (!p.bookingUrl) p.bookingUrl = '';
  }

  // Filter out obviously invalid entries
  const validPrices = raw.filter(
    (p) => p.price > 0 && p.airline && p.airline.length > 0
  );

  if (validPrices.length === 0) {
    console.log(`[extract] FAIL all_filtered_out — ${raw.length} raw results all invalid`);
    return { prices: [], usage: result.usage, failureReason: 'all_filtered_out' };
  }

  // Apply server side duration filter. The LLM extracts the duration string
  // (e.g. "11h 20m") and we parse it deterministically here so the filter is
  // testable without the LLM and consistent across providers.
  const durationFiltered = filters.maxDurationHours
    ? validPrices.filter((p) => {
        const minutes = parseDurationToMinutes(p.duration);
        return minutes === null || minutes <= filters.maxDurationHours! * 60;
      })
    : validPrices;

  if (durationFiltered.length === 0) {
    console.log(`[extract] FAIL all_filtered_out — duration filter (max ${filters.maxDurationHours}h) removed all ${validPrices.length} flights`);
    return { prices: [], usage: result.usage, failureReason: 'all_filtered_out' };
  }

  console.log(`[extract] OK — ${durationFiltered.length} flights extracted (cheapest: $${durationFiltered[0]?.price})`);
  return { prices: durationFiltered, usage: result.usage };
}
