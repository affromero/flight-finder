/** @vitest-environment jsdom */
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VpnPreferences, type VpnReadiness } from './VpnPreferences';

const patches: Record<string, unknown>[] = [];
let patchStatus: number, readinessFails: boolean, networkFails: boolean, delayed: Promise<void> | undefined;
function Wrapper({ provider: initial = 'none', status = null }: { provider?: string; status?: VpnReadiness | null }) {
  const [provider, setProvider] = useState(initial);
  const [countries, setCountries] = useState(['US']);
  const [current, setCurrent] = useState(status);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  return <><VpnPreferences provider={provider} countries={countries} revision={{ updatedAt: '2026-10-06T00:00:00Z', providerRevision: 1 }}
    onProviderChange={setProvider} onCountriesChange={setCountries} onSaved={() => setSaved(true)} onStatus={setCurrent} status={current} onBusyChange={setBusy} />
    {saved && <output>Persisted preferences</output>}<button disabled={busy}>Other configuration save</button></>;
}
beforeEach(() => {
  patches.length = 0; patchStatus = 200; readinessFails = false; networkFails = false; delayed = undefined;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/admin/config') {
      patches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (delayed) await delayed;
      return new Response(JSON.stringify(patchStatus === 200 ? { ok: true, data: { vpnProvider: 'mullvad', vpnCountries: ['US', 'DE'], updatedAt: '2026-10-06T01:00:00Z', providerRevision: 2 } }
        : { ok: false, error: 'Configuration changed; reload before saving' }), { status: patchStatus });
    }
    if (networkFails) throw Error('network failure');
    return new Response(JSON.stringify(readinessFails ? { ok: false, error: 'Unavailable' }
      : { ok: true, data: { provider: 'mullvad', configured: true, sidecarRunning: true, ready: true, countries: ['US', 'DE'] } }), { status: readinessFails ? 503 : 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save VPN preferences' }));

describe('VPN preference controls', () => {
  it('saves a normalized country selection and concurrency revision without an ExpressVPN code', async () => {
    render(<Wrapper />);
    fireEvent.change(screen.getByLabelText('VPN provider'), { target: { value: 'mullvad' } });
    fireEvent.change(screen.getByLabelText('Comparison countries'), { target: { value: 'us, de, US' } });
    save(); await screen.findByText('VPN configured');
    expect(patches).toEqual([{ vpnProvider: 'mullvad', vpnCountries: ['US', 'DE'], expectedUpdatedAt: '2026-10-06T00:00:00Z', expectedRevision: 1 }]);
    expect(screen.getByLabelText('Comparison countries')).toHaveValue('US, DE');
    expect(screen.getByText('VPN ready: US, DE')).toBeInTheDocument();
  });
  it('shows the Mullvad setup requirements and authoritative guide', () => {
    render(<Wrapper provider="mullvad" />);
    expect(screen.getByRole('link', { name: 'Setup guide' })).toHaveAttribute('href', 'https://tailscale.com/docs/features/exit-nodes/mullvad-exit-nodes');
    expect(screen.getByText(/enable the Mullvad add-on/)).toBeInTheDocument();
  });
  it('rejects countries without a supported profile before saving', async () => {
    render(<Wrapper provider="mullvad" />);
    fireEvent.change(screen.getByLabelText('Comparison countries'), { target: { value: 'ZA' } });
    save(); expect(screen.getByText(/Use two-letter country codes/)).toBeInTheDocument();
    expect(patches).toEqual([]);
  });
  it('retains the draft when the server rejects a stale revision', async () => {
    patchStatus = 409; render(<Wrapper provider="mullvad" />);
    fireEvent.change(screen.getByLabelText('Comparison countries'), { target: { value: 'US, DE' } });
    save(); await screen.findByText('Configuration changed; reload before saving');
    expect(screen.getByLabelText('Comparison countries')).toHaveValue('US, DE');
    expect(screen.queryByText('Persisted preferences')).not.toBeInTheDocument();
  });
  it.each(['http', 'network'])('distinguishes saved preferences from %s readiness failure', async mode => {
    readinessFails = mode === 'http'; networkFails = mode === 'network';
    render(<Wrapper provider="mullvad" />); save();
    await screen.findByText(/Preferences saved. VPN readiness could not be verified/);
    expect(screen.getByText('Persisted preferences')).toBeInTheDocument();
    expect(screen.queryByText('VPN configured')).not.toBeInTheDocument();
  });
  it('holds the submitted values while saving', async () => {
    let finish!: () => void; delayed = new Promise(resolve => { finish = resolve; });
    render(<Wrapper provider="mullvad" />); save();
    await waitFor(() => expect(screen.getByLabelText('VPN provider')).toBeDisabled());
    expect(screen.getByLabelText('Comparison countries')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Other configuration save' })).toBeDisabled();
    await act(async () => finish()); await screen.findByText('VPN configured');
  });
  it('does not show another provider readiness for the selected provider', () => {
    render(<Wrapper provider="mullvad" status={{ provider: 'expressvpn', configured: true, sidecarRunning: true, ready: true }} />);
    expect(screen.queryByText('VPN ready')).not.toBeInTheDocument();
  });
});
