import { EXTRACTION_PROVIDERS, CLI_PROVIDERS, LOCAL_PROVIDERS, resolveApiKey, type ExtractionResult } from './ai-registry';
import { prisma } from '@/lib/prisma';

export interface Airport {
  code: string; // IATA 3-letter code
  name: string; // City/airport name
}

export interface ParsedFlightQuery {
  origin: string;      // primary origin IATA code (first in origins array)
  originName: string;  // primary origin city name
  destination: string; // primary destination IATA code (first in destinations array)
  destinationName: string;
  origins: Airport[];      // all origin airports (e.g., JFK + EWR for "New York")
  destinations: Airport[]; // all destination airports (e.g., ORD + MDW for "Chicago")
  dateFrom: string; // ISO date — earliest outbound date (derived from outboundDates or range)
  dateTo: string; // ISO date — latest date across outbound+return (derived)
  outboundDates?: string[]; // specific departure dates, e.g. ["2026-03-15", "2026-03-20"]
  returnDates?: string[];   // specific return dates, e.g. ["2026-03-22", "2026-03-25"]
  flexibility: number; // days
  maxPrice: number | null;
  maxStops: number | null; // 0 = nonstop only, 1 = max 1 stop, null = any
  maxDurationHours: number | null; // total trip duration cap (hours), null = no cap
  preferredAirlines: string[]; // empty = no preference
  timePreference: 'any' | 'morning' | 'afternoon' | 'evening' | 'redeye';
  cabinClass: 'economy' | 'premium_economy' | 'business' | 'first';
  tripType: 'one_way' | 'round_trip';
  currency: string | null; // ISO 4217 currency code (e.g., USD, EUR, GBP). null = auto-detect
}

export interface ParseAmbiguity {
  field: 'date' | 'origin' | 'destination' | 'general';
  question: string;
  options?: string[];
}

export interface ParseResponse {
  parsed: ParsedFlightQuery | null;
  confidence: 'high' | 'medium' | 'low';
  ambiguities: ParseAmbiguity[];
  dateSpanDays: number;
}

function buildSystemPrompt(): string {
  const today = new Date().toISOString().split('T')[0];
  return `You are a flight query parser. Extract structured flight search parameters from natural language input.

Return ONLY valid JSON with this exact shape:
{
  "confidence": "high" | "medium" | "low",
  "ambiguities": [
    { "field": "date" | "origin" | "destination" | "general", "question": "clarifying question", "options": ["option1", "option2"] }
  ],
  "parsed": {
    "origins": [{ "code": "JFK", "name": "New York JFK" }, { "code": "EWR", "name": "Newark" }],
    "destinations": [{ "code": "ORD", "name": "Chicago O'Hare" }, { "code": "MDW", "name": "Chicago Midway" }],
    "dateFrom": "YYYY-MM-DD earliest departure date",
    "dateTo": "YYYY-MM-DD latest date (across outbound + return)",
    "outboundDates": ["YYYY-MM-DD", "..."] or null,
    "returnDates": ["YYYY-MM-DD", "..."] or null,
    "flexibility": number of days of flexibility (0 if exact dates),
    "maxPrice": number or null,
    "maxStops": number or null (0 if "nonstop"/"direct", 1 if "max 1 stop", null if no preference),
    "maxDurationHours": number or null (e.g. 20 for "duration under 20 hours"),
    "preferredAirlines": ["Delta", "United"] or [] if no preference,
    "timePreference": "any" | "morning" | "afternoon" | "evening" | "redeye",
    "cabinClass": "economy" | "premium_economy" | "business" | "first",
    "tripType": "one_way" | "round_trip",
    "currency": null
  }
}

CRITICAL — "parsed" must ALWAYS be filled:
- If origin and destination are clearly stated (e.g. "from Dusseldorf to Chicago"), ALWAYS fill origins and destinations arrays — even if dates are ambiguous or confidence is "low"
- Only set "parsed" to null if the input is truly unparseable (gibberish, no flight intent)
- Only ask about fields that are actually unclear. NEVER ask "Where are you flying from?" if the user already said it
- When multiple dates are mentioned (e.g. "Friday or Saturday"), use your best guess for dateFrom/dateTo and ask ONLY about the date — do not re-ask origin/destination

Multi-destination rules:
- "origins" and "destinations" are arrays of { "code": "IATA", "name": "City/Airport Name" }
- When the user names MULTIPLE DIFFERENT cities as destinations (e.g. "to Bogota and Medellin", "NYC or LA", "Bogota, Medellin, and Cartagena"), include ALL cities in the destinations array:
  - "Frankfurt to Bogota and Medellin" → destinations: [{ "code": "BOG", "name": "Bogota" }, { "code": "MDE", "name": "Medellin" }]
  - "NYC to Lima or Cartagena" → destinations: [{ "code": "LIM", "name": "Lima" }, { "code": "CTG", "name": "Cartagena" }]
  - Same applies to origins: "from Berlin or Munich to Rome" → origins: [{ "code": "BER", "name": "Berlin" }, { "code": "MUC", "name": "Munich" }]
- This generates separate searches for each origin × destination combo

Multi-airport rules (same city, different airports):
- For cities with ONE major airport (e.g. Dusseldorf, Paris), return a single-element array: [{ "code": "DUS", "name": "Dusseldorf" }]
- For cities with MULTIPLE major airports, list ALL relevant airports:
  - "New York" → [{ "code": "JFK", "name": "New York JFK" }, { "code": "EWR", "name": "Newark" }, { "code": "LGA", "name": "LaGuardia" }]
  - "Chicago" → [{ "code": "ORD", "name": "Chicago O'Hare" }, { "code": "MDW", "name": "Chicago Midway" }]
  - "London" → [{ "code": "LHR", "name": "London Heathrow" }, { "code": "LGW", "name": "London Gatwick" }, { "code": "STN", "name": "London Stansted" }]
  - "Tokyo" → [{ "code": "NRT", "name": "Tokyo Narita" }, { "code": "HND", "name": "Tokyo Haneda" }]
  - "Washington DC" → [{ "code": "IAD", "name": "Washington Dulles" }, { "code": "DCA", "name": "Washington Reagan" }]
  - "San Francisco Bay Area" → [{ "code": "SFO", "name": "San Francisco" }, { "code": "OAK", "name": "Oakland" }, { "code": "SJC", "name": "San Jose" }]
- If the user specifies a SPECIFIC airport (e.g. "from JFK"), return only that one airport in the array
- Put the most common/major airport first in the array (it becomes the default)

Confidence rules:
- "high": clear origin, destination, and specific date(s) within 14 days span. For round trips with both legs pinned (one or a few dates per leg, each leg's window ≤ 7 days), the trip itself can be any length — only the per-leg flexibility matters.
- "medium": mostly clear but one ambiguity (e.g., city has multiple airports, 2-3 possible dates mentioned, or one leg of a round trip has a window > 7 days while the other is pinned)
- "low": too vague (no dates, unclear cities, date range > 14 days for one-way, both legs of a round trip wide open, or missing origin/destination)

When confidence is "medium" or "low":
- Still fill in "parsed" with your best guess for ALL fields you can determine
- Add clear, concise clarifying questions in "ambiguities" ONLY for the unclear fields
- Examples of good ambiguities:
  - { "field": "date", "question": "Did you mean Friday Mar 14 or Saturday Mar 15?", "options": ["Friday Mar 14", "Saturday Mar 15", "Both days"] }
  - { "field": "origin", "question": "Which New York airport?", "options": ["JFK", "EWR", "LGA"] }
  - { "field": "date", "question": "That's a 30-day window. Can you narrow it to specific dates?", "options": ["First week", "Second week", "Last week"] }
  - { "field": "date", "question": "That's a 12-day outbound window. Pick a specific outbound date or narrow the range." }
  - { "field": "date", "question": "That's a 9-day return window. Pick a specific return date or narrow the range." }
  - When the issue is one specific leg of a round trip, name the leg ("outbound" or "return") in the question so the user knows which window to narrow

When confidence is "high":
- Set "ambiguities" to an empty array []

Multi-date rules:
- "outboundDates": when the user mentions SPECIFIC individual departure dates (e.g., "March 15 or March 20", "fly on the 10th and the 15th"), populate with each date as an array. Set dateFrom to the earliest, dateTo to the latest (across both outbound and return dates).
- "returnDates": when the user mentions SPECIFIC individual return dates (e.g., "return March 22 or March 25"), populate with each date. For one-way trips, set to null.
- When only a single date or a continuous range is mentioned (e.g., "June 15-20", "around June 15"), leave outboundDates and returnDates as null — use dateFrom/dateTo as before.
- For round trips: if the user says "fly March 15, return March 20", set outboundDates to ["YYYY-MM-15"] and returnDates to ["YYYY-MM-20"]. If they say "fly March 15 or 16, return March 20 or 21", set outboundDates to both departure dates and returnDates to both return dates.
- For round trips with a RANGE on each leg (e.g. "March 1-3 out, March 22-24 return", "depart sometime D1 to D2, return sometime E1 to E2"): expand each range into the individual dates and populate outboundDates with the outbound dates and returnDates with the return dates. dateFrom is the earliest outbound date (D1), dateTo is the latest return date (E2). Confidence stays "high" as long as each leg's window is at most 7 days wide. NEVER ask the user to "narrow the window from D1 to E2" — that's the trip duration, not a flexibility ambiguity.
- Maximum 6 dates per array. If the user mentions more, pick the 6 most likely.

Parsing rules:
- List all major airports for multi-airport cities (see multi-airport rules above)
- If the user says "around June 15 ± 3 days", set dateFrom to June 12, dateTo to June 18, flexibility to 3
- If the user says "June 15-20", set dateFrom to June 15, dateTo to June 20, flexibility to 0
- If the user says "next Friday or next Saturday", set outboundDates to both dates, dateFrom to the earlier, dateTo to the later, flexibility to 0, and confidence to "high"
- If the user says "next month" or "sometime in July", confidence is "low" — ask to narrow
- If the user says "flexible" without specifying days, use flexibility of 3
- Default cabinClass to "economy" unless stated otherwise
- Default timePreference to "any" unless stated
- tripType: "one_way" if no return date is mentioned or user says "one way"; "round_trip" if a return date is given or user says "round trip" or "return". Default to "one_way" when ambiguous (no return info)
- Extract airline preferences if mentioned
- Extract price caps if mentioned (e.g. "under $800")
- Extract trip duration caps when phrased as "under N hours", "less than Nh", "max N hours", "duration < Nh", "shorter than N hours", "no more than Nh", or "flights shorter than N hours". Round fractional values up to whole hours. Set maxDurationHours to null if not mentioned.
- If no stop preference stated, maxStops is null
- Extract currency if mentioned (e.g. "in euros" → "EUR", "prices in pounds" → "GBP", "in CAD" → "CAD", "¥" → "JPY"). Set to null if not mentioned by the user. Use ISO 4217 codes.
- Ignore trailing fragments or incomplete words at the end of the input — parse what you can
- Today's date is ${today}
- If this is a follow-up response to a previous question, incorporate the user's answer to refine the query
- Return ONLY the JSON object, no markdown, no explanation`;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const LEG_WINDOW_LIMIT_DAYS = 7;
const SINGLE_RANGE_LIMIT_DAYS = 14;
const CONVERSATION_HISTORY_LIMIT = 6;

/** Span in days between the earliest and latest date in a sorted ISO date array. */
function legSpanDays(dates: string[] | undefined): number {
  if (!dates || dates.length < 2) return 0;
  const first = new Date(dates[0]!).getTime();
  const last = new Date(dates[dates.length - 1]!).getTime();
  return Math.ceil((last - first) / MS_PER_DAY);
}

/** Normalize LLM response to always have origins/destinations arrays + derived single fields */
function normalizeAirports(parsed: Record<string, unknown>): ParsedFlightQuery {
  const p = parsed as Record<string, unknown>;

  // If LLM returned new format (origins/destinations arrays)
  let origins: Airport[] = Array.isArray(p.origins)
    ? (p.origins as Airport[]).filter((a) => a.code && a.name)
    : [];
  let destinations: Airport[] = Array.isArray(p.destinations)
    ? (p.destinations as Airport[]).filter((a) => a.code && a.name)
    : [];

  // Fall back to legacy single origin/destination fields
  if (origins.length === 0 && typeof p.origin === 'string' && p.origin) {
    origins = [{ code: p.origin as string, name: (p.originName as string) || p.origin as string }];
  }
  if (destinations.length === 0 && typeof p.destination === 'string' && p.destination) {
    destinations = [{ code: p.destination as string, name: (p.destinationName as string) || p.destination as string }];
  }

  // Normalize outboundDates / returnDates — validate ISO date strings, sort, then cap.
  // When both legs are ranges (>1 date each), cap at 4 per leg to stay under the
  // scrape combo budget (preview/route.ts: combos × dates ≤ 24). Otherwise cap at 6.
  const rawOutbound = Array.isArray(p.outboundDates)
    ? (p.outboundDates as string[]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    : undefined;
  const rawReturn = Array.isArray(p.returnDates)
    ? (p.returnDates as string[]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    : undefined;
  const bothLegsRanged = (rawOutbound?.length ?? 0) > 1 && (rawReturn?.length ?? 0) > 1;
  const perLegCap = bothLegsRanged ? 4 : 6;
  const outboundDates = rawOutbound?.slice(0, perLegCap);
  const returnDates = rawReturn?.slice(0, perLegCap);

  // Derive dateFrom/dateTo from individual dates when present
  const allDates = [...(outboundDates ?? []), ...(returnDates ?? [])];
  let dateFrom = p.dateFrom as string;
  let dateTo = p.dateTo as string;
  if (allDates.length > 0) {
    const sorted = allDates.sort();
    dateFrom = sorted[0]!;
    dateTo = sorted[sorted.length - 1]!;
  }

  return {
    ...(p as unknown as ParsedFlightQuery),
    origins,
    destinations,
    origin: origins[0]?.code ?? '',
    originName: origins[0]?.name ?? '',
    destination: destinations[0]?.code ?? '',
    destinationName: destinations[0]?.name ?? '',
    currency: typeof p.currency === 'string' && p.currency ? p.currency : null,
    maxDurationHours: typeof p.maxDurationHours === 'number' && p.maxDurationHours > 0 ? p.maxDurationHours : null,
    dateFrom,
    dateTo,
    outboundDates: outboundDates?.length ? outboundDates : undefined,
    returnDates: returnDates?.length ? returnDates : undefined,
  };
}

export async function parseFlightQuery(
  rawInput: string,
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<{ response: ParseResponse; usage: ExtractionResult['usage'] }> {
  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
  });

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
  // DB-stored key takes precedence over the env var so a GUI-entered key works
  // without editing .env or restarting the stack (#149).
  const apiKey = isCliProvider ? '' : resolveApiKey(provider, config);
  if (!apiKey && !isCliProvider && !hasLocalEndpoint) {
    throw new Error(`Missing API key: ${providerConfig.envKey}`);
  }

  // Build prompt with conversation history. Cap to the most recent turns to
  // prevent token bloat across long clarification loops. Clamp each entry's
  // content so a single oversized entry cannot inflate the prompt beyond a
  // safe bound (CONVERSATION_HISTORY_LIMIT turns x 2000 chars = ~12 KB max).
  const HISTORY_ENTRY_MAX_CHARS = 2000;
  let fullPrompt = rawInput;
  if (conversationHistory?.length) {
    const recentHistory = conversationHistory.slice(-CONVERSATION_HISTORY_LIMIT);
    fullPrompt = recentHistory
      .map((m) => {
        const content = String(m.content).slice(0, HISTORY_ENTRY_MAX_CHARS);
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${content}`;
      })
      .join('\n') + '\nUser: ' + rawInput;
  }

  const result = await providerConfig.extract(
    apiKey,
    model,
    buildSystemPrompt(),
    fullPrompt,
    {
      baseUrl: config?.customBaseUrl ?? undefined,
      // Read the admin configured timeout from the DB so slow CPU bound local
      // models can be granted more than the 90s default (issue #86). Falls
      // through to the env var driven default inside each extract function
      // when the column is null.
      ...(typeof config?.extractTimeoutSeconds === 'number'
        ? { timeoutMs: config.extractTimeoutSeconds * 1000 }
        : {}),
      // Constrain local providers to emit a JSON object. Without this, small
      // Ollama models occasionally return prose or a refusal and the regex
      // below finds nothing (issue #84). Gated to LOCAL_PROVIDERS only because
      // custom OpenAI compatible endpoints (OPENAI_BASE_URL, OpenRouter, etc.)
      // may route to models that reject `response_format` outright; the
      // default OpenAI model follows the JSON instruction reliably anyway.
      ...(isLocalProvider ? { responseFormat: 'json_object' as const } : {}),
    }
  );

  const jsonMatch = result.content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    const preview = result.content.slice(0, 200).replace(/\s+/g, ' ');
    console.error(
      `[parse-query] FAIL no_json_in_response provider=${provider} model=${model} length=${result.content.length} preview=${preview}`,
    );
    throw new Error('Failed to parse LLM response as JSON');
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const preview = jsonMatch[0].slice(0, 200).replace(/\s+/g, ' ');
    console.error(
      `[parse-query] FAIL json_parse_error provider=${provider} model=${model} length=${jsonMatch[0].length} err=${msg} preview=${preview}`,
    );
    throw new Error('Failed to parse LLM response as JSON', { cause: err });
  }

  // Handle both old format (flat ParsedFlightQuery) and new format (with confidence envelope)
  let parsed: ParsedFlightQuery | null;
  let confidence: ParseResponse['confidence'];
  let ambiguities: ParseAmbiguity[];

  if ('confidence' in raw && 'parsed' in raw) {
    // New envelope format
    const rawParsed = raw.parsed as Record<string, unknown> | null;
    parsed = rawParsed ? normalizeAirports(rawParsed) : null;
    confidence = (raw.confidence as string) === 'high' ? 'high'
      : (raw.confidence as string) === 'medium' ? 'medium' : 'low';
    ambiguities = Array.isArray(raw.ambiguities) ? raw.ambiguities as ParseAmbiguity[] : [];
  } else {
    // Legacy flat format — treat as high confidence
    parsed = normalizeAirports(raw);
    confidence = 'high';
    ambiguities = [];
  }

  // Validate required fields on parsed
  if (parsed && (!parsed.origins.length || !parsed.destinations.length || !parsed.dateFrom || !parsed.dateTo)) {
    parsed = null;
    confidence = 'low';
    if (ambiguities.length === 0) {
      ambiguities.push({
        field: 'general',
        question: 'I need at least an origin, destination, and travel dates. Can you be more specific?',
      });
    }
  }

  // Compute date span and enforce server-side safety net
  let dateSpanDays = 0;
  if (parsed) {
    dateSpanDays = Math.ceil(
      (new Date(parsed.dateTo).getTime() - new Date(parsed.dateFrom).getTime()) / MS_PER_DAY
    );

    // For round trips with specific dates on either leg, validate each leg's
    // window separately. The trip duration (gap between outbound and return)
    // is not a flexibility ambiguity, so we don't flag it.
    const hasLegArrays =
      (parsed.outboundDates?.length ?? 0) > 0 || (parsed.returnDates?.length ?? 0) > 0;
    const isRoundTripWithLegs = parsed.tripType === 'round_trip' && hasLegArrays;

    if (isRoundTripWithLegs) {
      if (confidence === 'high') {
        const outboundSpan = legSpanDays(parsed.outboundDates);
        const returnSpan = legSpanDays(parsed.returnDates);
        if (outboundSpan > LEG_WINDOW_LIMIT_DAYS) {
          confidence = 'medium';
          ambiguities.push({
            field: 'date',
            question: `That's a ${outboundSpan}-day outbound window. Pick a specific outbound date or narrow the range.`,
          });
        }
        if (returnSpan > LEG_WINDOW_LIMIT_DAYS) {
          confidence = 'medium';
          ambiguities.push({
            field: 'date',
            question: `That's a ${returnSpan}-day return window. Pick a specific return date or narrow the range.`,
          });
        }
      }
    } else if (dateSpanDays > SINGLE_RANGE_LIMIT_DAYS && confidence === 'high') {
      confidence = 'medium';
      ambiguities.push({
        field: 'date',
        question: `That's a ${dateSpanDays}-day window. Can you narrow it to specific dates or a shorter range?`,
        options: ['First week', 'Second week', 'Last week', 'Specific dates'],
      });
    }
  }

  return {
    response: { parsed, confidence, ambiguities, dateSpanDays },
    usage: result.usage,
  };
}
