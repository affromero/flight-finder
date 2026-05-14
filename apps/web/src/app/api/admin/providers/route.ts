import { apiSuccess } from '@/lib/api-response';
import { EXTRACTION_PROVIDERS, LOCAL_PROVIDERS, detectAvailableProviders } from '@/lib/scraper/ai-registry';
import { requireAdminApi } from '@/lib/admin-guard';

interface ProviderStatus {
  displayName: string;
  status: 'ready' | 'no_key' | 'not_installed' | 'unreachable';
  models: string[];
}

export async function GET() {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const available = await detectAvailableProviders();
  const isSelfHosted = process.env.SELF_HOSTED === 'true';

  const statuses: Record<string, ProviderStatus> = {};

  for (const [key, config] of Object.entries(EXTRACTION_PROVIDERS)) {
    let status: ProviderStatus['status'];
    if (available.includes(key)) {
      status = 'ready';
    } else if (LOCAL_PROVIDERS.has(key)) {
      status = isSelfHosted ? 'unreachable' : 'not_installed';
    } else if (key === 'claude-code' || key === 'codex') {
      status = 'not_installed';
    } else {
      status = 'no_key';
    }

    statuses[key] = {
      displayName: config.displayName,
      status,
      models: config.models.map((m) => m.name),
    };
  }

  return apiSuccess(statuses);
}
