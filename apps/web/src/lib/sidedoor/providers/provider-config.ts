import { providerDescriptors } from 'thesidedoor-core/ai/catalog';
import { cookies } from 'next/headers';
import { AccessError, isAccessError } from 'thesidedoor-core/access';
import type { CredentialValues } from 'thesidedoor-core/ai';
import { apiProviders } from 'thesidedoor-core/ai/providers';
import { CredentialDecryptionError, type CredentialVault } from 'thesidedoor-core/configuration';
import type { Prisma } from '@/generated/prisma/client';
import { sharedAccess, sharedAccessStore, SHARED_SESSION_COOKIE } from '../access/service';
import { providerVault, resetProviderCredentials } from './provider-credentials';
import { accessHandler } from '../access/access';
import { withAccessBody } from '../access/access-http';
import { apiError } from '@/lib/api-response';
import { lockTravelAdmission } from '@/lib/travel/admission';

export function providerConfigurationError(error: unknown): Response {
  if (isAccessError(error)) return apiError(error.code, { unauthorized: 401, forbidden: 403, invalid: 400, conflict: 409, rate_limited: 429 }[error.code]);
  if (error instanceof ProviderConfigurationConflict) return apiError(error.message, 409);
  if (error instanceof CredentialDecryptionError) return apiError('Stored provider credentials are unavailable. Replace or remove the affected credentials.', 409);
  if (error instanceof Error && 'code' in error && error.code === 'invalid_request') return apiError(error.message, 400);
  throw error;
}

export function parseCredentialPatch(value: unknown): CredentialPatch | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccessError('invalid');
  for (const field of Object.values(value)) {
    if (field !== null && typeof field !== 'string' && typeof field !== 'number' && typeof field !== 'boolean') throw new AccessError('invalid');
    if (typeof field === 'number' && !Number.isFinite(field)) throw new AccessError('invalid');
  }
  return value as CredentialPatch;
}

export async function configurationRequestOwner(request: Request) {
  const preflight = await (await accessHandler())(withAccessBody(request, {}), 'authorize-owner');
  if (!preflight.ok) return { response: preflight };
  const token = (await cookies()).get(SHARED_SESSION_COOKIE)?.value;
  if (!token) throw new AccessError('unauthorized');
  await sharedAccess.authenticate(token, true, true);
  return { token };
}

export class ProviderConfigurationConflict extends Error {}
export type CredentialPatch = Record<string, string | number | boolean | null>;
export type ProviderCredentialDescription = Omit<Awaited<ReturnType<CredentialVault['describe']>>, 'error'> & { error?: string };

export async function readProviderConfiguration(ownerToken: string) {
  return sharedAccessStore.ownerTransaction(ownerToken, async database => {
    const config = await database.extractionConfig.upsert({ where: { id: 'singleton' }, create: { id: 'singleton' }, update: {} });
    const credentials = await describeProviderCredentials(database);
    return { config, credentials };
  }, false);
}

export async function describeProviderCredentials(database: Prisma.TransactionClient): Promise<ProviderCredentialDescription[]> {
  const descriptions: ProviderCredentialDescription[] = [];
  const { vault } = providerVault(database);
  for (const descriptor of providerDescriptors()) {
    try {
      descriptions.push(await vault.describe(descriptor.id));
    } catch (error) {
      if (!(error instanceof CredentialDecryptionError)) throw error;
      descriptions.push({ provider: descriptor.id, error: 'stored_credentials_unavailable', fields: descriptor.fields.map(field => ({ id: field.id, configured: false, source: 'unset' as const })) });
    }
  }
  return descriptions;
}

function assertCredentials(provider: string, values: CredentialValues): void {
  const descriptor = providerDescriptors().find(item => item.id === provider);
  if (!descriptor) throw new Error('Unknown provider');
  if (descriptor.transport === 'cli' || descriptor.transport === 'ssh') return;
  const adapter = apiProviders().find(item => item.descriptor.id === provider);
  if (!adapter?.validateConfiguration) throw new Error('Provider configuration validation is unavailable');
  adapter.validateConfiguration({ credentials: values, signal: new AbortController().signal });
}

/** Network discovery occurs before this call; its configuration revision is checked before saving. */
export async function saveProviderConfiguration(ownerToken: string, options: {
  data: Prisma.ExtractionConfigUncheckedCreateInput;
  fields?: CredentialPatch;
  expectedUpdatedAt: Date | null;
  expectedRevision?: number;
  resetCredentials?: boolean;
  setup?: boolean;
  admissionLock?: boolean;
}) {
  return sharedAccessStore.ownerTransaction(ownerToken, async database => {
    if (options.admissionLock) await lockTravelAdmission(database);
    const current = await database.extractionConfig.findUnique({ where: { id: 'singleton' } });
    if (options.expectedRevision !== undefined && options.expectedRevision !== (current?.providerRevision ?? 0)) throw new ProviderConfigurationConflict('Configuration changed. Reload before saving.');
    if ((current?.updatedAt.getTime() ?? null) !== (options.expectedUpdatedAt?.getTime() ?? null)) throw new ProviderConfigurationConflict('Configuration changed. Reload before saving.');
    if (options.setup && current?.setupComplete) throw new ProviderConfigurationConflict('Setup is already complete');
    const provider = options.data.provider ?? current?.provider ?? 'anthropic';
    const changesProvider = options.setup || options.resetCredentials || Object.keys(options.fields ?? {}).length > 0
      || (options.data.provider !== undefined && provider !== current?.provider)
      || (options.data.model !== undefined && options.data.model !== current?.model)
      || (options.data.reasoningEffort !== undefined && options.data.reasoningEffort !== current?.reasoningEffort);
    let customBaseUrl = current?.customBaseUrl ?? null;
    if (changesProvider) {
      const { vault } = options.resetCredentials
        ? await resetProviderCredentials(database, provider)
        : providerVault(database);
      if (options.fields) await vault.configure(provider, options.fields);
      const values = await vault.resolve(provider);
      const removalOnly = options.resetCredentials && Object.keys(options.fields ?? {}).length === 0
        && provider === current?.provider
        && (options.data.model === undefined || options.data.model === current?.model)
        && (options.data.reasoningEffort === undefined || options.data.reasoningEffort === current?.reasoningEffort);
      if (options.setup || !removalOnly) assertCredentials(provider, values);
      customBaseUrl = typeof values.baseUrl === 'string' ? values.baseUrl : null;
    }
    const config = await database.extractionConfig.upsert({
      where: { id: 'singleton' },
      create: { ...options.data, id: 'singleton', customBaseUrl, providerRevision: 1 },
      update: { ...options.data, customBaseUrl, providerRevision: { increment: 1 } },
    });
    const credentials = await describeProviderCredentials(database);
    return { config, credentials };
  });
}
