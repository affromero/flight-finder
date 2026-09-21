import { CredentialVault, credentialStateSchema, initialCredentialState } from 'thesidedoor-core/configuration';
import { providerDescriptors } from 'thesidedoor-core/ai/catalog';
import type { CredentialValues } from 'thesidedoor-core/ai';
import type { Prisma } from '@/generated/prisma/client';
import { deriveSecretEncryptionKey } from '@/lib/secret-crypto';
import { sharedStateStore } from '../access/store';
import { serializable } from '../access/transaction';

export function providerVault(database: Prisma.TransactionClient) {
  const store = sharedStateStore('provider-credentials', credentialStateSchema.parse, initialCredentialState, database);
  return {
    store,
    vault: new CredentialVault({
      store,
      namespace: 'flight-finder:provider-credentials',
      encryptionKey: deriveSecretEncryptionKey,
      descriptors: providerDescriptors,
    }),
  };
}

export async function initializeProviderCredentials(): Promise<{ warnings: string[] }> {
  await serializable(async database => providerVault(database).store.read());
  return { warnings: [] };
}

export async function resolveProviderCredentials(provider: string): Promise<CredentialValues> {
  return serializable(async database => {
    const { vault } = providerVault(database);
    return vault.resolve(provider);
  });
}

/** Called only inside the recent-owner configuration transaction after explicit reset. */
export async function resetProviderCredentials(database: Prisma.TransactionClient, provider: string) {
  const { store, vault } = providerVault(database);
  await store.transact(state => {
    vault.removeState(state, provider);
  });
  return { store, vault };
}
