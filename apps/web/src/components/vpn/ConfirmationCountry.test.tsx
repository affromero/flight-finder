/** @vitest-environment jsdom */
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmationCard, type ParsedQuery } from '../ConfirmationCard';

const parsed: ParsedQuery = { origin: 'JFK', originName: 'New York', destination: 'LAX', destinationName: 'Los Angeles', origins: [], destinations: [],
  dateFrom: '2027-06-15', dateTo: '2027-06-20', flexibility: 0, maxPrice: null, maxStops: null, maxDurationHours: null, preferredAirlines: [],
  timePreference: 'any', cabinClass: 'economy', tripType: 'roundtrip', currency: 'USD' };
afterEach(() => vi.unstubAllGlobals());
it('allows removing a selected country whose exit became unavailable while blocking a new selection', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, data: { provider: 'mullvad', configured: true, sidecarRunning: true, ready: true, countries: ['US'] } })));
  function Wrapper() {
    const [countries, setCountries] = useState(['DE']);
    const [tracked, setTracked] = useState<string[] | null>(null);
    return <><ConfirmationCard parsed={parsed} loading={false} onTrack={() => setTracked(countries)} onEdit={() => setTracked(null)} vpnCountries={countries} onVpnCountriesChange={setCountries} />
      {tracked && <output>{JSON.stringify(tracked)}</output>}</>;
  }
  render(<Wrapper />);
  await screen.findByText('VPN ready');
  fireEvent.click(screen.getByRole('button', { name: /Global price check/i }));
  const chip = screen.getByRole('button', { name: /DE$/ });
  expect(chip).toBeEnabled(); fireEvent.click(chip); expect(chip).toBeDisabled();
  expect(screen.getByRole('button', { name: /US$/ })).toBeEnabled();
});
