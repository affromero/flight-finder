import { prisma } from '@/lib/prisma';
import { detectAvailableProviders } from '@/lib/scraper/ai-registry';
import { currentAccessSession } from '@/lib/sidedoor/session';
import { cookies } from 'next/headers';
import { sharedAccessStore, SHARED_SESSION_COOKIE } from '@/lib/sidedoor/service';
import { describeProviderCredentials } from '@/lib/sidedoor/provider-config';

export async function GET(request?: Request) {
  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
  });

  const isSelfHosted = process.env.SELF_HOSTED === 'true';
  const setupComplete = config?.setupComplete === true;

  // Once setup is complete the instance is configured and may be publicly
  // reachable, so expose only the two booleans the setup wizard and
  // SetupRedirect component need. Provider names and model/key details of a
  // live instance must not be revealed to unauthenticated callers (security
  // wave 4).
  if (setupComplete) {
    return Response.json({ setupComplete: true, needsSetup: false });
  }

  const auth = await currentAccessSession();
  if (auth?.principal?.role !== 'owner') return Response.json({ setupComplete: false, needsSetup: true });

  const detectedProviders = await detectAvailableProviders(request?.signal);
  const token = (await cookies()).get(SHARED_SESSION_COOKIE)?.value;
  if (!token) return Response.json({ setupComplete: false, needsSetup: true });
  const providerCredentials = await sharedAccessStore.ownerTransaction(token, database => describeProviderCredentials(database), false);
  return Response.json({
    setupComplete: false,
    needsSetup: true,
    isSelfHosted,
    detectedProviders,
    providerCredentials,
    currentProvider: config?.provider ?? null,
    currentModel: config?.model ?? null,
  });
}
