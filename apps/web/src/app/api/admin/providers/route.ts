import { apiSuccess } from '@/lib/api-response';
import { EXTRACTION_PROVIDERS, detectProviderReadiness, type ProviderAvailability } from '@/lib/scraper/ai-registry';
import { requireAdminApi } from '@/lib/admin-guard';

interface ProviderStatus {
  displayName: string;
  status: ProviderAvailability;
  models: string[];
}

export async function GET(request?: Request) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const readiness = await detectProviderReadiness(request?.signal);

  const statuses: Record<string, ProviderStatus> = {};

  for (const [key, config] of Object.entries(EXTRACTION_PROVIDERS)) {
    const status = readiness[key];
    if (!status) throw new Error('Missing provider readiness result');

    statuses[key] = {
      displayName: config.displayName,
      status,
      models: config.models.map((m) => m.name),
    };
  }

  return apiSuccess(statuses);
}
