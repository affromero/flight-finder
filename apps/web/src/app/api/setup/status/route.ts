import { prisma } from '@/lib/prisma';
import { detectAvailableProviders } from '@/lib/scraper/ai-registry';

export async function GET() {
  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
  });

  const isSelfHosted = process.env.SELF_HOSTED === 'true';
  // Setup is complete once the explicit setup flow has run -- it always sets
  // adminPasswordHash ('self-hosted' sentinel on self-hosted). Do NOT key off
  // provider: it is a NOT NULL column with a default ("anthropic"), so any
  // config row (e.g. one created by the admin-config GET upsert before setup)
  // would otherwise look complete and wrongly skip the wizard / hide detection.
  const setupComplete = Boolean(config?.adminPasswordHash);

  // Once setup is complete the instance is configured and may be publicly
  // reachable, so expose only the two booleans the setup wizard and
  // SetupRedirect component need. Provider names and model/key details of a
  // live instance must not be revealed to unauthenticated callers (security
  // wave 4).
  if (setupComplete) {
    return Response.json({ setupComplete: true, needsSetup: false });
  }

  // First-run only. The wizard is necessarily unauthenticated here (no admin
  // exists yet) and needs provider detection to render the picker. Nothing
  // sensitive is configured at this point, and the rich shape stops being
  // served the moment setup completes -- strictly more private than the
  // pre-hardening route, which returned providers unconditionally.
  const detectedProviders = await detectAvailableProviders();
  return Response.json({
    setupComplete: false,
    needsSetup: true,
    isSelfHosted,
    detectedProviders,
    currentProvider: config?.provider ?? null,
    currentModel: config?.model ?? null,
  });
}
