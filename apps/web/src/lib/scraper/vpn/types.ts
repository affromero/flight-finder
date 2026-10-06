export type VpnProviderType = 'none' | 'expressvpn' | 'mullvad';

export interface VpnStatus {
  connected: boolean;
  currentLocation: string | null;
  currentCountry: string | null;
}

export interface VpnProvider {
  readonly type: VpnProviderType;

  /** Get current connection status */
  getStatus(signal?: AbortSignal): Promise<VpnStatus>;

  /** Connect to a specific country. Returns true if successful. */
  connect(countryCode: string, signal?: AbortSignal): Promise<boolean>;

  /** Disconnect from VPN entirely */
  disconnect(signal?: AbortSignal): Promise<void>;

  /** List available location names this provider supports */
  listLocations(signal?: AbortSignal): Promise<string[]>;

  /** Whether this is a system-wide VPN (sequential only) vs per-context proxy */
  isSystemWide(): boolean;

  /** Get the SOCKS5/HTTP proxy URL for Playwright (only for non-system-wide providers) */
  getProxyUrl?(): string | undefined;
}
