import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { cached } from '@/lib/redis';
import { LOCAL_PROVIDERS } from '@/lib/scraper/ai-registry';
import { requireAdminApi } from '@/lib/admin-guard';

interface OllamaModel {
  name: string;
  size: number;
  details?: { parameter_size?: string };
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

interface LocalModel {
  id: string;
  name: string;
  size: string;
}

function resolveOllamaHost(customBaseUrl: string | null): string {
  // customBaseUrl is stored with /v1 suffix (e.g. http://localhost:11434/v1)
  // Strip it to get the raw Ollama host for the native API
  if (customBaseUrl) {
    return customBaseUrl.replace(/\/v1\/?$/, '');
  }
  const envHost = process.env.OLLAMA_HOST;
  if (envHost) {
    return envHost.replace(/\/+$/, '');
  }
  return 'http://localhost:11434';
}

const DEFAULT_HOSTS: Record<string, string> = {
  llamacpp: 'http://localhost:8080',
  vllm: 'http://localhost:8000',
};

function resolveOpenAICompatHost(provider: string, customBaseUrl: string | null): string {
  if (customBaseUrl) {
    return customBaseUrl.replace(/\/v1\/?$/, '');
  }
  return DEFAULT_HOSTS[provider] ?? 'http://localhost:8000';
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}MB`;
}

async function fetchOllamaModels(host: string): Promise<LocalModel[]> {
  const res = await fetch(`${host}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const data = (await res.json()) as OllamaTagsResponse;
  return (data.models ?? []).map((m) => ({
    id: m.name,
    name: m.name,
    size: m.details?.parameter_size || formatSize(m.size),
  }));
}

async function fetchOpenAICompatModels(provider: string, host: string): Promise<LocalModel[]> {
  const res = await fetch(`${host}/v1/models`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${provider} returned ${res.status}`);
  const data = (await res.json()) as { data: { id: string }[] };
  return (data.data ?? []).map((m) => ({
    id: m.id,
    name: m.id,
    size: '',
  }));
}

export async function GET(request: NextRequest) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const provider = request.nextUrl.searchParams.get('provider');
  if (!provider || !LOCAL_PROVIDERS.has(provider)) {
    return apiError('provider must be one of: ' + [...LOCAL_PROVIDERS].join(', '), 400);
  }

  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
    select: { customBaseUrl: true, provider: true },
  });

  // Only use stored customBaseUrl if it belongs to the requested provider
  const storedUrl = config?.provider === provider ? config.customBaseUrl : null;

  const host = provider === 'ollama'
    ? resolveOllamaHost(storedUrl)
    : resolveOpenAICompatHost(provider, storedUrl);
  const cacheKey = `local-models:${provider}:${host}`;

  try {
    const models = await cached(
      cacheKey,
      async () => {
        if (provider === 'ollama') return fetchOllamaModels(host);
        return fetchOpenAICompatModels(provider, host);
      },
      300, // 5 min TTL
    );

    return apiSuccess(models);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    return apiError(`Could not connect to ${provider}: ${message}`, 502);
  }
}
