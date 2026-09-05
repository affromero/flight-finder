import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { HotelClient } from '../lib/hotel-client.js';

interface Tracker { id: string; hotelName: string; active: boolean; latestPrice: number | null; currency: string; lastError: string | null }
interface Detail { tracker: Tracker; snapshots: { id: string; scrapedAt: string; offer: { totalPrice: number; currency: string; roomName: string | null; match: string }; eligible: boolean }[]; notificationsConfigured: boolean }

export function HotelBrowser({ server }: { server: string }) {
  const client = useMemo(() => new HotelClient(server, process.env.FLIGHT_FINDER_SESSION, process.env.FLIGHT_FINDER_TOKEN), [server]);
  const { exit } = useApp();
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    client.request<{ trackers: Tracker[] }>('/api/hotels', 'GET', undefined, controller.signal)
      .then((data) => { setTrackers(data.trackers); setError(''); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => setBusy(false));
    return () => controller.abort();
  }, [client, revision]);
  const view = async (id: string) => {
    setBusy(true);
    try { setDetail(await client.request<Detail>(`/api/hotels/${encodeURIComponent(id)}`)); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const mutate = async (refresh: boolean) => {
    if (!detail) return;
    setBusy(true);
    try {
      await client.request(`/api/hotels/${encodeURIComponent(detail.tracker.id)}${refresh ? '/scrape' : ''}`, refresh ? 'POST' : 'PATCH', refresh ? undefined : { active: !detail.tracker.active });
      await view(detail.tracker.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  useInput((input, key) => {
    if (input === 'q') exit();
    if (key.escape) { setDetail(null); setRevision((value) => value + 1); }
    if (busy) return;
    if (input === 'p' && detail) void mutate(false);
    if (input === 'r' && detail) void mutate(true);
  });
  return <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">Flight Finder · Hotels</Text>
    {error && <Text color="red">{error}</Text>}
    {busy && <Text>Loading hotels…</Text>}
    {!detail && !busy && <>
      {trackers.length === 0 ? <Text>No hotel trackers. Run hotels search --query "your stay" --wait, then hotels track.</Text>
        : <SelectInput items={trackers.map((tracker) => ({ value: tracker.id, label: `${tracker.hotelName} · ${tracker.active ? 'active' : 'paused'} · ${tracker.latestPrice === null ? 'No price yet' : `${tracker.currency} ${tracker.latestPrice}`}` }))} onSelect={(item) => { void view(item.value); }} />}
    </>}
    {detail && <>
      <Text bold>{detail.tracker.hotelName} · {detail.tracker.active ? 'Active' : 'Paused'}</Text>
      {!detail.notificationsConfigured && <Text color="yellow">Configure a notification channel in your server settings to receive alerts.</Text>}
      {detail.tracker.lastError && <Text color="red">Last check: {detail.tracker.lastError}</Text>}
      {detail.snapshots.slice(0, 20).map((snapshot) => <Text key={snapshot.id}>{snapshot.scrapedAt} · {snapshot.offer.currency} {snapshot.offer.totalPrice} · {snapshot.offer.roomName ?? 'Room unspecified'} · {snapshot.offer.match}{snapshot.eligible ? '' : ' · does not qualify'}</Text>)}
      <Text dimColor>p pause/resume · r refresh · Esc back</Text>
    </>}
    <Text dimColor>q quit · Hotel search and alert settings: flightfinder hotels --help</Text>
  </Box>;
}
