import type { VpnProvider, VpnProviderType } from './types';
import { NoopVpnProvider } from './noop-provider';
import { ExpressVpnProvider } from './expressvpn-provider';
import { MullvadVpnProvider } from './mullvad-provider';

export function createVpnProvider(type: VpnProviderType): VpnProvider {
  switch (type) {
    case 'expressvpn':
      return new ExpressVpnProvider();
    case 'mullvad':
      return new MullvadVpnProvider();
    case 'none':
      return new NoopVpnProvider();
    default:
      throw new Error('Unsupported VPN configuration');
  }
}
export type { VpnProvider, VpnProviderType } from './types';
