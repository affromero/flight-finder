import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useWindowSize, useStderr } from 'ink';
import TextInput from 'ink-text-input';
import { CarConfirmation } from './CarConfirmation.js';
import { CarLocations } from './CarLocations.js';
import { CarBrowser as Browser, carTerminalText } from '../lib/car-browser.js';
import { formatCarMoney } from '../../../../apps/web/src/lib/cars/money.js';

export function CarBrowser({ browser, signal }: { browser: Browser; signal: AbortSignal }) {
  const state = useSyncExternalStore(browser.subscribe, browser.getSnapshot);
  const { exit } = useApp(), { rows } = useWindowSize();
  const { write } = useStderr();
  const [selected, setSelected] = useState(0), [offset, setOffset] = useState(0);
  const [deliveryMode, setDeliveryMode] = useState(false);
  const [locationMode, setLocationMode] = useState(false);
  useEffect(() => { setLocationMode(false); }, [state.scope, state.hidden, state.detail?.tracker.id]);
  const [recoveryForm, setRecoveryForm] = useState(false), [receiptPath, setReceiptPath] = useState('');
  const enteringReceipt = recoveryForm && !state.hidden;
  const available = Math.max(1, Math.floor((rows - (state.detail ? deliveryMode ? 16 : 14 : 9)) / (state.detail && deliveryMode ? 2 : 1)));
  const selection = Math.max(0, Math.min(selected, state.trackers.length - 1));
  const snapshots = state.detail?.snapshots ?? [];
  const deliveries = state.detail?.deliveries ?? [], historyLength = deliveryMode ? deliveries.length : snapshots.length;
  const historyOffset = Math.min(offset, Math.max(0, historyLength - available));
  useEffect(() => browser.subscribeReceipts(path => write(`Recovery receipt: ${carTerminalText(path)}\n`)), [browser, write]);
  useEffect(() => {
    const stop = () => { browser.close(); exit(); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop(); else void browser.reload();
    return () => { signal.removeEventListener('abort', stop); browser.close(); };
  }, [browser, signal, exit]);
  useInput((input, key) => {
    if (key.ctrl && input === 'c' || input === 'q' && !enteringReceipt && !state.confirmation) { browser.close(); exit(); return; }
    if (state.mutationBusy) return;
    if (state.confirmation) { if (key.escape) browser.cancelConfirmation(); return; }
    if (locationMode && state.detail && !state.hidden) { if (key.escape) setLocationMode(false); return; }
    if (enteringReceipt) { if (key.escape) setRecoveryForm(false); return; }
    if (input === 'r') { void browser.reload(); return; }
    if (state.busy) return;
    if (input === 't' && !state.hidden) { setReceiptPath(''); setRecoveryForm(true); return; }
    if (key.escape && state.detail) { setOffset(0); void browser.back(); return; }
    if (state.detail) {
      if (input === 'l') { setLocationMode(true); return; }
      if (input === 'd') { setDeliveryMode(value => !value); setOffset(0); }
      if (input === 'p') browser.requestAction(state.detail.tracker.active ? 'pause' : 'resume');
      if (input === 'c') browser.requestAction('refresh');
      if (input === 'x') browser.requestAction('delete');
      if (key.downArrow) setOffset(Math.min(historyOffset + 1, Math.max(0, historyLength - available)));
      if (key.upArrow) setOffset(Math.max(0, historyOffset - 1));
      return;
    }
    if (key.downArrow) setSelected(Math.max(0, Math.min(selection + 1, state.trackers.length - 1)));
    if (key.upArrow) setSelected(Math.max(0, selection - 1));
    if (key.return && state.trackers[selection]) { setOffset(0); setDeliveryMode(false); void browser.open(state.trackers[selection].id); }
    if (input === 'n') { setSelected(0); void browser.nextPage(); }
    if (input === 'b') { setSelected(0); void browser.previousPage(); }
  });
  const price = (minor: number | null, currency: string) => minor === null ? 'No eligible price' : formatCarMoney({ minor, currency });
  const start = Math.max(0, selection - available + 1);
  if (locationMode && state.detail && !state.hidden && !state.confirmation) return <CarLocations key={`${state.scope}:${state.detail.tracker.id}:${state.detail.tracker.revision}`} tracker={state.detail.tracker} />;
  if (state.confirmation) return <Box flexDirection="column" paddingX={1}>
    <CarConfirmation confirmation={state.confirmation} rows={rows} onConfirm={() => { void browser.confirm(); }} />
  </Box>;
  return <Box flexDirection="column" paddingX={1}>
    <Text bold color="#80a8a5">FLIGHT FINDER / CARS</Text>
    <Text dimColor>Whole-rental prices · independent of flights and hotels</Text>
    {state.error && <Text color="#c1272d" wrap="truncate-end">{carTerminalText(state.error)}</Text>}
    {state.notice && <Text color="#80a8a5">{state.notice}</Text>}
    {state.busy && <Text color="#80a8a5">Loading verified rental data…</Text>}
    {state.mutationBusy && <Text color="#80a8a5">Waiting for acknowledgement… Exiting retains the recovery receipt.</Text>}
    {enteringReceipt && !state.confirmation && <>
      <Text bold color="#80a8a5">RECOVER A SAVED REQUEST</Text>
      {state.recoveries.slice(-5).map((row, index) => <Text key={row.path} wrap="truncate-end">{Math.max(0, state.recoveries.length - 5) + index + 1}. {row.outcome} · {carTerminalText(row.path)}</Text>)}
      <Text>Enter a receipt path or a number above. You will review it before sending.</Text>
      <Box><Text>Receipt: </Text><TextInput value={receiptPath} onChange={value => setReceiptPath(carTerminalText(value).slice(0, 4096))} onSubmit={value => {
        const path = /^\d+$/.test(value) ? state.recoveries[Number(value) - 1]?.path : value;
        if (path) { setRecoveryForm(false); void browser.reviewReceipt(path); }
      }} /></Box>
      <Text dimColor>Esc back</Text>
    </>}
    {!state.hidden && !state.detail && !state.confirmation && !enteringReceipt && <>
      <Text color="#ecdfc0">YOUR TRACKERS · PAGE {state.page + 1}</Text>
      {!state.busy && state.trackers.length === 0 && <Text>No car trackers. Use cars search, then cars track to save an offer.</Text>}
      {state.trackers.slice(start, start + available).map((tracker, index) => <Text key={tracker.id} color={start + index === selection ? '#80a8a5' : '#ecdfc0'} wrap="truncate-end">
        {start + index === selection ? '› ' : '  '}{price(tracker.latestPriceMinor, tracker.currency)} · {tracker.active ? 'Active' : 'Paused'} · {carTerminalText(tracker.label)}
      </Text>)}
      <Text dimColor>↑↓ select · Enter history · {state.nextCursor ? 'n next page · ' : ''}{state.page > 0 ? 'b previous page · ' : ''}r reload</Text>
    </>}
    {!state.hidden && state.detail && !state.confirmation && !enteringReceipt && <>
      <Text bold color="#ecdfc0" wrap="truncate-end">{carTerminalText(state.detail.tracker.label)}</Text>
      <Text>{state.detail.tracker.active ? 'Active' : 'Paused'} · revision {state.detail.tracker.revision} · {carTerminalText(state.detail.tracker.id)}</Text>
      <Text color="#80a8a5">Latest: {price(state.detail.tracker.latestPriceMinor, state.detail.tracker.currency)} · Low: {price(state.detail.tracker.historicalLowMinor, state.detail.tracker.currency)}</Text>
      <Text dimColor>{state.detail.notificationsConfigured ? 'Notification channel configured; delivery is not guaranteed.' : 'No notification channel configured. Configure one in server settings.'}</Text>
      {state.detail.tracker.lastError && <Text color="#c1272d" wrap="truncate-end">Last check: {carTerminalText(state.detail.tracker.lastError)}</Text>}
      <Text bold>{deliveryMode ? 'NOTIFICATION DELIVERY' : 'PRICE EVIDENCE'} · {historyLength ? `${historyOffset + 1}–${Math.min(historyOffset + available, historyLength)} of ${historyLength}` : deliveryMode ? 'No alert delivery recorded' : 'No observations yet'}</Text>
      {deliveryMode ? <>
        <Text dimColor wrap="truncate-end">Channel acceptance does not confirm reading.</Text>
        <Text dimColor wrap="truncate-end">Lost acknowledgements can repeat alerts.</Text>
        {deliveries.slice(historyOffset, historyOffset + available).map(delivery => <Box key={delivery.id} flexDirection="column">
          <Text wrap="truncate-end">{delivery.createdAt.slice(0, 16).replace('T', ' ')} UTC · {({ waiting: 'Waiting', claimed: 'Claimed for delivery', retrying: 'Waiting to retry', accepted: 'Accepted by channels', stopped: 'Further delivery stopped' })[delivery.status]} · {delivery.acknowledgedChannels} channel acknowledgements</Text>
          <Text dimColor wrap="truncate-end">{delivery.nextAttemptAt ? `Next attempt no earlier than ${delivery.nextAttemptAt} (estimated)` : 'No further attempt scheduled'}</Text>
        </Box>)}
      </> : snapshots.slice(historyOffset, historyOffset + available).map(snapshot => <Text key={snapshot.id} wrap="truncate-end">
        {snapshot.observedAt.slice(0, 16).replace('T', ' ')} UTC · {price(snapshot.totalMinor, snapshot.currency)} · {snapshot.eligible ? 'Eligible' : `Excluded: ${carTerminalText(snapshot.reasons.join('; '))}`} · {carTerminalText(snapshot.source)}
      </Text>)}
      <Text dimColor>↑↓ history · l locations · d {deliveryMode ? 'prices' : 'deliveries'} · Esc trackers · r reload status</Text>
      <Text dimColor>p pause/resume · c check prices · x delete (confirmation required)</Text>
    </>}
    {!state.confirmation && !enteringReceipt && state.recoveries.some(row => row.outcome !== 'confirmed') && <Text color="#c1272d">Recovery receipts need review. Press t to select one.</Text>}
    <Text dimColor>{state.confirmation || enteringReceipt ? 'Ctrl-C' : 'q'} quit (server work continues) · t recover receipt · cars --help</Text>
  </Box>;
}
