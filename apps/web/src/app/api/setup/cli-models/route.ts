import { apiError, apiSuccess } from '@/lib/api-response';
import { setupComplete } from '@/lib/setup-state';
import { discoverCliModels } from '@/lib/scraper/cli-models';
import { CliTestError, testCliSelection } from '@/lib/scraper/cli-test';
import { InferenceSelectionError } from '@/lib/scraper/inference-selection';

export async function GET(request: Request) {
  if (await setupComplete()) return apiError('Setup is complete; use administrator settings', 403);
  const url = new URL(request.url), provider = url.searchParams.get('provider');
  if (provider !== 'codex' && provider !== 'claude-code') return apiError('Choose a supported CLI provider', 400);
  try { return apiSuccess(await discoverCliModels(provider, url.searchParams.get('refresh') === 'true')); }
  catch (error) { return apiError(error instanceof Error ? error.message : 'CLI model discovery failed', 502); }
}

export async function POST(request: Request) {
  if (await setupComplete()) return apiError('Setup is complete; use administrator settings', 403);
  try { return apiSuccess(await testCliSelection(await request.json(), request.signal)); }
  catch (error) {
    if (error instanceof SyntaxError) return apiError('Invalid JSON request', 400);
    return apiError(error instanceof Error ? error.message : 'CLI test failed', error instanceof CliTestError ? error.status : error instanceof InferenceSelectionError ? 400 : 502);
  }
}
