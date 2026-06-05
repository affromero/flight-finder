import { prisma } from '@/lib/prisma';

export async function GET() {
  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
  });

  const isSelfHosted = process.env.SELF_HOSTED === 'true';
  const setupComplete = isSelfHosted
    ? Boolean(config?.provider)
    : Boolean(config?.adminPasswordHash);

  // Return only the boolean the setup wizard and SetupRedirect component need.
  // Provider names and key-presence details are internal configuration that
  // must not be revealed to unauthenticated callers.
  return Response.json({
    setupComplete,
    needsSetup: !setupComplete,
  });
}
