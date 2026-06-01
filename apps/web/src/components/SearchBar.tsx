'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { ParseAmbiguity, ParsedFlightQuery } from '@/lib/scraper/parse-query';
import type { ConversationMessage } from '@/lib/clarification-types';
import type { PreviewRunStatusPayload } from '@/lib/preview-run';
import type { PriceData } from '@/lib/scraper/extract-prices';
import { detectLocaleCurrency } from '@/lib/currency';
import { addSavedTracker } from '@/lib/tracker-storage';
import styles from './SearchBar.module.css';
import { ClarificationCard } from './ClarificationCard';
import { ConfirmationCard, type ParsedQuery } from './ConfirmationCard';
import { FlightPicker, type RouteFlights } from './FlightPicker';
import { LinkBanner, type CreatedTracker } from './LinkBanner';
import { ManualEntryForm, type ManualFormValues } from './ManualEntryForm';

// "ft-" prefix kept across the Flight Finder rename so existing browsers preserve state.
const PREVIEW_STORAGE_KEY_BASE = 'ft-preview-run';
const PREVIEW_POLL_TIMEOUT_MS = 30 * 60 * 1000;

function previewStorageKey(surface: SearchSurface): string {
  return surface === 'admin' ? `${PREVIEW_STORAGE_KEY_BASE}-admin` : PREVIEW_STORAGE_KEY_BASE;
}

export type SearchSurface = 'public' | 'admin';

interface SavedPreviewState {
  previewRunId: string;
  parsed: ParsedQuery;
  query: string;
  manualRawInput: string;
  vpnCountries: string[];
  startedAt: number;
}

function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    // Audio not available
  }
}

function readSavedPreview(key: string): SavedPreviewState | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as SavedPreviewState;
  } catch {
    return null;
  }
}

function writeSavedPreview(key: string, state: SavedPreviewState) {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

function clearSavedPreview(key: string) {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

export function SearchBar({
  initialQuery,
  surface = 'public',
}: {
  initialQuery?: string;
  surface?: SearchSurface;
} = {}) {
  const storageKey = previewStorageKey(surface);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [ambiguities, setAmbiguities] = useState<ParseAmbiguity[]>([]);
  const [partialParsed, setPartialParsed] = useState<ParsedFlightQuery | null>(null);

  const [previewRoutes, setPreviewRoutes] = useState<RouteFlights[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRunId, setPreviewRunId] = useState<string | null>(null);

  const [vpnCountries, setVpnCountries] = useState<string[]>([]);
  const [adminCurrency, setAdminCurrency] = useState<string | null>(null);
  const [maxTrackedPerRoute, setMaxTrackedPerRoute] = useState(10);

  const [createdTrackers, setCreatedTrackers] = useState<CreatedTracker[] | null>(null);

  const [activeSearchMethod, setActiveSearchMethod] = useState<'ai' | 'manual'>('ai');
  const [manualMode, setManualMode] = useState(false);
  const [manualRawInput, setManualRawInput] = useState('');
  const [manualFormValues, setManualFormValues] = useState<ManualFormValues | null>(null);

  useEffect(() => {
    fetch('/api/admin/config')
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) return;
        if (d.data.defaultCurrency) setAdminCurrency(d.data.defaultCurrency);
        if (typeof d.data.maxTrackedPerRoute === 'number') setMaxTrackedPerRoute(d.data.maxTrackedPerRoute);
        const searchMethod = d.data.defaultSearchMethod === 'manual' ? 'manual' : 'ai';
        setActiveSearchMethod(searchMethod);
        setManualMode(searchMethod === 'manual');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const saved = readSavedPreview(storageKey);
    if (!saved) return;

    setParsed(saved.parsed);
    setQuery(saved.query);
    setManualRawInput(saved.manualRawInput);
    setVpnCountries(saved.vpnCountries);
    setPreviewRunId(saved.previewRunId);
    setPreviewLoading(true);
  }, [storageKey]);

  const doParse = useCallback(async (input: string, history: ConversationMessage[]): Promise<boolean> => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: input,
          conversationHistory: history.length > 0 ? history : undefined,
        }),
      });

      const data = await res.json();

      if (!data.ok) {
        setError(data.error || 'Failed to parse query');
        return false;
      }

      const { parsed: nextParsed, confidence, ambiguities: nextAmbiguities } = data.data;

      if (nextParsed && !nextParsed.currency) {
        nextParsed.currency = adminCurrency || detectLocaleCurrency();
      }

      if (confidence === 'high' && nextParsed) {
        setParsed(nextParsed);
        setAmbiguities([]);
        setPartialParsed(null);
      } else {
        setParsed(null);
        setAmbiguities(nextAmbiguities || []);
        setPartialParsed(nextParsed);

        // Store one assistant turn per question so the stacked dialog renders
        // each as its own bubble. Fall back to a single placeholder turn when
        // the LLM gave no questions.
        const assistantTurns: ConversationMessage[] = nextAmbiguities?.length
          ? nextAmbiguities.map((ambiguity: ParseAmbiguity) => ({
              role: 'assistant' as const,
              content: ambiguity.question,
            }))
          : [{ role: 'assistant' as const, content: 'Can you be more specific?' }];
        setConversation((prev) => [...prev, ...assistantTurns]);
      }
      return true;
    } catch {
      setError('Network error - please try again');
      return false;
    } finally {
      setLoading(false);
    }
  }, [adminCurrency]);

  useEffect(() => {
    if (!previewRunId || !parsed) return;

    let cancelled = false;
    let timer: number | null = null;

    const checkCutoff = (): boolean => {
      const saved = readSavedPreview(storageKey);
      if (saved && Date.now() - saved.startedAt > PREVIEW_POLL_TIMEOUT_MS) {
        setError('Flight search took too long. Please try again.');
        setPreviewLoading(false);
        setPreviewRunId(null);
        clearSavedPreview(storageKey);
        return true;
      }
      return false;
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/preview/${previewRunId}`, { cache: 'no-store' });
        const data = await res.json();

        if (cancelled) return;

        if (!data.ok) {
          setError(data.error || 'Failed to search flights');
          setPreviewLoading(false);
          setPreviewRunId(null);
          clearSavedPreview(storageKey);
          return;
        }

        const preview = data.data as PreviewRunStatusPayload;

        // Terminal states beat the cutoff: if the backend finished at
        // T+cutoff+1ms, we still honor the result instead of throwing it away.
        if (preview.status === 'completed' && preview.result) {
          playNotificationSound();
          setPreviewRoutes(preview.result.routes);
          setPreviewLoading(false);
          setPreviewRunId(null);
          clearSavedPreview(storageKey);
          return;
        }

        if (preview.status === 'failed') {
          setError(preview.error || 'Failed to search flights');
          setPreviewLoading(false);
          setPreviewRunId(null);
          clearSavedPreview(storageKey);
          return;
        }

        if (checkCutoff()) return;

        timer = window.setTimeout(poll, 2000);
      } catch {
        if (cancelled) return;
        // Catch path also has to respect the cutoff. Without this, a
        // network or JSON failure that persists for 30+ minutes would
        // keep polling forever and never surface the timeout error.
        if (checkCutoff()) return;
        timer = window.setTimeout(poll, 3000);
      }
    };

    setPreviewLoading(true);
    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [previewRunId, parsed, storageKey]);

  const handleParse = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 5) return;

    const history: ConversationMessage[] = [{ role: 'user', content: trimmed }];
    setConversation(history);
    setAmbiguities([]);
    setPartialParsed(null);
    setParsed(null);
    setPreviewRoutes(null);
    setPreviewRunId(null);
    setCreatedTrackers(null);
    setManualRawInput('');
    setManualFormValues(null);
    clearSavedPreview(storageKey);

    await doParse(trimmed, []);
  }, [query, doParse, storageKey]);

  const handleAnswer = useCallback(async (answer: string): Promise<boolean> => {
    const newConversation: ConversationMessage[] = [...conversation, { role: 'user', content: answer }];
    setConversation(newConversation);
    // Pass the updated history (including the just-added user turn minus the
    // raw answer string itself, since doParse re-appends it) so the LLM sees
    // every prior turn — not the stale pre-answer slice.
    return doParse(answer, conversation);
  }, [conversation, doParse]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleParse();
    }
  };

  const handlePreview = async () => {
    if (!parsed) return;

    setPreviewLoading(true);
    setError(null);
    setPreviewRoutes(null);

    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });

      const data = await res.json();

      if (!data.ok) {
        setError(data.error || 'Failed to search flights');
        setPreviewLoading(false);
        return;
      }

      const nextPreviewRunId = data.data.previewRunId as string | undefined;
      if (!nextPreviewRunId) {
        setError('Failed to start flight search');
        setPreviewLoading(false);
        return;
      }

      setPreviewRunId(nextPreviewRunId);
      writeSavedPreview(storageKey, {
        previewRunId: nextPreviewRunId,
        parsed,
        query,
        manualRawInput,
        vpnCountries,
        startedAt: Date.now(),
      });
    } catch {
      setError('Network error - please try again');
      setPreviewLoading(false);
    }
  };

  const handleTrackSelected = async (routeSelections: Array<{ route: RouteFlights; flights: PriceData[] }>) => {
    if (!parsed) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawInput: manualRawInput || query.trim(),
          dateFrom: parsed.dateFrom,
          dateTo: parsed.dateTo,
          flexibility: parsed.flexibility,
          maxPrice: parsed.maxPrice,
          maxStops: parsed.maxStops,
          maxDurationHours: parsed.maxDurationHours ?? null,
          preferredAirlines: parsed.preferredAirlines,
          timePreference: parsed.timePreference,
          currency: parsed.currency,
          cabinClass: parsed.cabinClass,
          tripType: parsed.tripType,
          vpnCountries,
          routes: routeSelections.map((selection) => ({
            origin: selection.route.origin,
            originName: selection.route.originName,
            destination: selection.route.destination,
            destinationName: selection.route.destinationName,
            date: selection.route.date,
            returnDate: selection.route.returnDate,
            selectedFlights: selection.flights,
          })),
        }),
      });

      const data = await res.json();

      if (!data.ok) {
        setError(data.error || 'Failed to create tracker');
        return;
      }

      const queries: Array<{
        id: string;
        origin: string;
        originName: string;
        destination: string;
        destinationName: string;
        date?: string;
        returnDate?: string;
        deleteToken: string;
        label: string | null;
      }> = data.data.queries;

      for (const trackedQuery of queries) {
        addSavedTracker({
          id: trackedQuery.id,
          origin: trackedQuery.origin,
          destination: trackedQuery.destination,
          originName: trackedQuery.originName,
          destinationName: trackedQuery.destinationName,
          dateFrom: trackedQuery.date || parsed.dateFrom,
          dateTo: trackedQuery.returnDate || parsed.dateTo,
          createdAt: new Date().toISOString(),
          deleteToken: trackedQuery.deleteToken,
          label: trackedQuery.label ?? undefined,
        });
      }

      setCreatedTrackers(queries.map((trackedQuery) => ({
        id: trackedQuery.id,
        origin: trackedQuery.origin,
        originName: trackedQuery.originName,
        destination: trackedQuery.destination,
        destinationName: trackedQuery.destinationName,
        date: trackedQuery.date,
      })));

      setPreviewRunId(null);
      clearSavedPreview(storageKey);
    } catch {
      setError('Network error - please try again');
    } finally {
      setLoading(false);
    }
  };

  const handleBackFromPicker = () => {
    setPreviewRoutes(null);
    setPreviewRunId(null);
    clearSavedPreview(storageKey);
  };

  const [editingValues, setEditingValues] = useState<ManualFormValues | null>(null);

  const handleReset = () => {
    setParsed(null);
    setError(null);
    setConversation([]);
    setAmbiguities([]);
    setPartialParsed(null);
    setPreviewRoutes(null);
    setPreviewLoading(false);
    setPreviewRunId(null);
    setCreatedTrackers(null);
    setManualMode(activeSearchMethod === 'manual');
    setManualRawInput('');
    setManualFormValues(null);
    setVpnCountries([]);
    setEditingValues(null);
    clearSavedPreview(storageKey);
    inputRef.current?.focus();
  };

  const handleEdit = () => {
    const wasManual = !!manualFormValues;

    setError(null);
    setConversation([]);
    setAmbiguities([]);
    setPartialParsed(null);
    setPreviewRoutes(null);
    setPreviewLoading(false);
    setPreviewRunId(null);
    setCreatedTrackers(null);
    clearSavedPreview(storageKey);

    if (wasManual) {
      setEditingValues(manualFormValues);
      setParsed(null);
      setManualMode(true);
    } else {
      setParsed(null);
      setEditingValues(null);
      inputRef.current?.focus();
    }
  };

  const showClarification = ambiguities.length > 0 && !parsed;
  const showConfirmation = parsed && !previewRoutes && !createdTrackers && !previewLoading;
  const showPreviewLoading = parsed && previewLoading && !previewRoutes;
  const showPicker = parsed && previewRoutes && !createdTrackers;

  return (
    <div className={styles.root}>
      {manualMode ? (
        <ManualEntryForm
          onSubmit={(nextParsed, rawInput, formValues) => {
            setParsed(nextParsed);
            setManualRawInput(rawInput);
            setManualFormValues(formValues);
            setManualMode(false);
            setEditingValues(null);
          }}
          onCancel={() => {
            setActiveSearchMethod('ai');
            setManualMode(false);
            setEditingValues(null);
          }}
          adminCurrency={adminCurrency}
          cancelLabel="Use AI search"
          initialValues={editingValues ?? undefined}
        />
      ) : (
        <>
          <div className={styles.inputWrapper}>
            <input
              ref={inputRef}
              type="text"
              className={styles.input}
              placeholder="NYC to Paris around June 15 +/- 3 days"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              autoFocus
            />
            <button
              className={styles.searchButton}
              onClick={handleParse}
              disabled={loading || query.trim().length < 5}
            >
              {loading ? (
                <span className={styles.spinner} />
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              )}
            </button>
          </div>

          <div className={styles.hints}>
            {['JFK to CDG June 15-20', 'London to Tokyo next month flexible', 'SFO to LAX March 20 +/- 2 days'].map((example, i) => (
              <span key={i}>
                {i > 0 && <span className={styles.hintSep}>&middot; </span>}
                <button
                  type="button"
                  className={styles.hintBtn}
                  onClick={() => {
                    setQuery(example);
                    inputRef.current?.focus();
                  }}
                >
                  {example}
                </button>
              </span>
            ))}
          </div>

          {!parsed && !loading && (
            <>
              <button
                type="button"
                className={styles.randomFlight}
                onClick={() => {
                  const base = new Date();
                  base.setDate(base.getDate() + 21 + Math.floor(Math.random() * 21));
                  const dep = base.toISOString().split('T')[0]!;
                  const ret = new Date(base);
                  ret.setDate(ret.getDate() + 5 + Math.floor(Math.random() * 5));
                  const retStr = ret.toISOString().split('T')[0]!;

                  const routes = [
                    `JFK to CDG ${dep} to ${retStr} round trip economy`,
                    `LAX to NRT ${dep} to ${retStr} round trip economy`,
                    `ORD to FCO ${dep} to ${retStr} round trip economy`,
                    `MIA to BOG ${dep} one way economy`,
                    `SFO to LHR ${dep} to ${retStr} round trip economy`,
                    `BOS to BCN ${dep} to ${retStr} round trip economy`,
                    `SEA to ICN ${dep} to ${retStr} round trip economy`,
                    `DEN to AMS ${dep} to ${retStr} round trip economy`,
                    `DFW to CUN ${dep} to ${retStr} round trip economy`,
                    `ATL to DUB ${dep} to ${retStr} round trip economy`,
                  ];
                  const pick = routes[Math.floor(Math.random() * routes.length)]!;
                  setQuery(pick);
                  void doParse(pick, []);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22M22 6l-4-4M22 6l-4 4M2 6h1.4c1.3 0 2.5.6 3.3 1.7l6.1 8.6c.7 1.1 2 1.7 3.3 1.7H22M22 18l-4-4M22 18l-4 4" />
                </svg>
                Try a random flight
              </button>
              <button
                type="button"
                className={styles.manualToggle}
                onClick={() => {
                  setError(null);
                  setAmbiguities([]);
                  setPartialParsed(null);
                  setActiveSearchMethod('manual');
                  setManualMode(true);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                Enter flight details manually
              </button>
            </>
          )}
        </>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {showClarification && (
        <ClarificationCard
          ambiguities={ambiguities}
          partialParsed={partialParsed}
          conversation={conversation}
          onAnswer={handleAnswer}
          onReset={handleReset}
          loading={loading}
        />
      )}

      {showConfirmation && (
        <ConfirmationCard
          parsed={parsed}
          onTrack={handlePreview}
          onEdit={handleEdit}
          loading={loading}
          vpnCountries={vpnCountries}
          onVpnCountriesChange={setVpnCountries}
        />
      )}

      {showPreviewLoading && parsed && (
        <div className={styles.previewLoading}>
          <span className={styles.previewRoute}>
            {parsed.origins.map((airport) => airport.code).join(', ')}
            {' -> '}
            {parsed.destinations.map((airport) => airport.code).join(', ')}
          </span>
          <span className={styles.previewStatus}>Searching Google Flights...</span>
        </div>
      )}

      {showPicker && previewRoutes && (
        <FlightPicker
          routes={previewRoutes}
          onTrack={handleTrackSelected}
          onBack={handleBackFromPicker}
          onEdit={handleEdit}
          loading={loading}
          maxSelectionsPerRoute={maxTrackedPerRoute}
        />
      )}

      {createdTrackers && (
        <LinkBanner
          trackers={createdTrackers}
          onDismiss={handleReset}
        />
      )}
    </div>
  );
}
