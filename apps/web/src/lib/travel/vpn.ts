import { prisma } from '@/lib/prisma';
import { createVpnProvider, type VpnProvider, type VpnProviderType } from '../scraper/vpn';
import { lockTravelLease, type TravelLeaseToken } from './admission';
import { TravelCleanupError } from './execution';
import { TravelJobError } from './errors';

/** Captures one provider instance and never mutates a network after losing authority. */
export class TravelVpnSession implements VpnProvider {
  readonly type: VpnProviderType;
  private readonly provider: VpnProvider;
  private uncertain = false;
  private touched = false;
  constructor(private readonly lease: TravelLeaseToken, type: VpnProviderType, private readonly signal?: AbortSignal) {
    this.type = type;
    this.provider = createVpnProvider(type);
  }
  private async authority(): Promise<void> {
    await prisma.$transaction(tx => lockTravelLease(tx, this.lease));
  }
  async getStatus() { this.signal?.throwIfAborted(); await this.authority(); return this.provider.getStatus(this.signal); }
  async listLocations() { this.signal?.throwIfAborted(); await this.authority(); return this.provider.listLocations(this.signal); }
  isSystemWide() { return this.provider.isSystemWide(); }
  getProxyUrl() { return this.provider.getProxyUrl?.(); }
  private async mutate(work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.authority();
    signal?.throwIfAborted();
    if (this.uncertain) throw new TravelJobError('VPN state is uncertain; administrator recovery is required', 503);
    this.touched = true;
    this.uncertain = true;
    await work();
    signal?.throwIfAborted();
    await this.authority();
    this.uncertain = false;
  }
  async connect(country: string): Promise<boolean> {
    await this.mutate(async () => {
      if (!(await this.provider.connect(country, this.signal))) throw new TravelJobError('Configured VPN country is unavailable', 503);
    }, this.signal);
    return true;
  }
  async disconnect(): Promise<void> {
    await this.mutate(() => this.provider.disconnect(this.signal), this.signal);
  }
  async prepare(): Promise<void> {
    if (this.type === 'none' || this.lease.id === 'browser') return;
    // A local pass starts from a verified disconnected network, including restart.
    await this.disconnect();
  }
  async dispose(): Promise<void> {
    if (this.uncertain) throw new TravelCleanupError([], 'VPN command completion is uncertain; automatic cleanup is unsafe');
    if (!this.touched) return;
    // Execution disposal aborts its signal even after success. Cleanup has its own deadline.
    const cleanup = AbortSignal.timeout(55_000);
    await this.mutate(() => this.provider.disconnect(cleanup), cleanup);
    this.touched = false;
  }
}
