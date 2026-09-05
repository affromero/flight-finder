import { prisma } from '../prisma';
import { EXTRACTION_PROVIDERS, LOCAL_PROVIDERS, resolveApiKey, getModelCosts } from '../scraper/ai-registry';
import { extractJsonArray } from '../scraper/extract-prices';
import { acquireProviderToken } from '../scraper/rate-limit';
import { validateHotelSearch } from './domain';
import type { HotelSearch } from './types';

export async function hotelJson(system: string, input: string, operation = 'hotel_extract'): Promise<unknown> {
  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const provider = config?.provider ?? 'anthropic';
  const backend = EXTRACTION_PROVIDERS[provider];
  if (!backend) throw new Error(`Unknown AI provider: ${provider}`);
  await acquireProviderToken(provider);
  const model = config?.model ?? 'claude-haiku-4-5-20251001';
  const started = Date.now();
  const result = await backend.extract(resolveApiKey(provider, config), model, `${system}\nIMPORTANT OUTPUT ENVELOPE: wrap the required object as {"result":[OBJECT]}. Exactly one object in result.`, input, {
    baseUrl: config?.customBaseUrl ?? undefined,
    timeoutMs: (config?.extractTimeoutSeconds ?? 90) * 1000,
    ...(LOCAL_PROVIDERS.has(provider) ? { responseFormat: 'json_object' as const } : {}),
  });
  const costs = getModelCosts(provider, model);
  await prisma.apiUsageLog.create({ data: {
    provider, model, ...result.usage, operation, durationMs: Date.now() - started,
    costUsd: (result.usage.inputTokens * costs.costPer1kInput + result.usage.outputTokens * costs.costPer1kOutput) / 1000,
  } });
  const json = extractJsonArray(result.content);
  if (!json.ok || json.value.length !== 1 || !json.value[0] || typeof json.value[0] !== 'object') throw new Error('Hotel AI response did not contain one JSON result');
  return json.value[0];
}

export async function parseHotelQuery(text: string): Promise<HotelSearch> {
  if (!text.trim() || text.length > 4000) throw new Error('Describe a hotel search in 1–4000 characters');
  const raw = await hotelJson(`Parse a hotel-only search into JSON. Today is ${new Date().toISOString().slice(0, 10)}.
Return {destination,dateMode,checkIn,checkOut,flexibility,minNights,maxNights,rooms,currency,sources,filters}.
Dates are YYYY-MM-DD. dateMode is fixed, nearby (vary check-in and check-out independently +/- flexibility days), or window (earliest arrival checkIn, latest departure checkOut, minNights/maxNights).
rooms is [{adults:2,children:[]}] by default; children contains ages, never invent missing ages. Currency defaults USD. sources defaults ["google_hotels","booking"].
filters is {maxTotal:null,refundable:false,breakfast:false,minStars:0,minRating:0,excludedSellers:[],amenities:[]} with amenities limited to parking,pool,pets,accessible. Rating uses 0–10. Budget is TOTAL stay for ALL rooms.
Use flexibility 0 and minNights/maxNights equal to stay length for fixed dates. Missing destination or dates must remain empty strings so validation requests clarification. Never infer a flight or airport. Output JSON only.`, text, 'hotel_parse');
  return validateHotelSearch(raw);
}
