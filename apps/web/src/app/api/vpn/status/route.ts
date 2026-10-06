import { apiSuccess } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { MullvadVpnProvider } from '@/lib/scraper/vpn/mullvad-provider';

export async function GET() {
  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });

  const vpnProvider = config?.vpnProvider ?? 'none';
  const hasActivationCode = !!config?.vpnActivationCode;
  const isConfigured = vpnProvider === 'mullvad' || (vpnProvider === 'expressvpn' && hasActivationCode);

  // Check if the sidecar is reachable
  let sidecarReachable = false;
  let countries: string[] = [];
  let error: string | null = null;
  if (isConfigured) {
    try {
      if (vpnProvider === 'mullvad') {
        const provider = new MullvadVpnProvider();
        const signal = AbortSignal.timeout(3000);
        await provider.getStatus(signal);
        countries = (await provider.listLocations(signal)).map(location => location.slice(0, 2));
        sidecarReachable = countries.length > 0;
        if (!sidecarReachable) error = 'No available Mullvad countries with supported browser profiles';
      } else {
        const apiUrl = process.env.EXPRESSVPN_API_URL || 'http://expressvpn:8000';
        const res = await fetch(`${apiUrl}/v1/status`, { signal: AbortSignal.timeout(3000) });
        sidecarReachable = res.ok;
        await res.body?.cancel();
        if (!sidecarReachable) error = 'ExpressVPN sidecar is unavailable';
      }
    } catch {
      error = 'VPN readiness could not be verified. Check the dedicated sidecar configuration and access.';
    }
  }
  if (!['none', 'expressvpn', 'mullvad'].includes(vpnProvider)) error = 'Unsupported VPN configuration';

  return apiSuccess({
    provider: vpnProvider,
    configured: isConfigured,
    sidecarRunning: sidecarReachable,
    ready: isConfigured && sidecarReachable,
    ...(vpnProvider === 'mullvad' ? { countries } : {}),
    ...(error ? { error } : {}),
  });
}
