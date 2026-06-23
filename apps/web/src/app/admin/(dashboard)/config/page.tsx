'use client';

import { useState, useEffect, useCallback } from 'react';
import { PROVIDER_METADATA, LOCAL_PROVIDERS } from '@/lib/scraper/provider-metadata';
import { ThemePicker } from '@/components/ThemePicker/ThemePicker';
import { isThemeId, DEFAULT_THEME, type ThemeId } from '@/lib/theme';
import styles from './page.module.css';

interface Config {
  provider: string;
  model: string;
  enabled: boolean;
  scrapeInterval: number;
  hasAdminPassword: boolean;
  communitySharing: boolean;
  communityRegistrationOpen: boolean;
  communityApiKey: string | null;
  theme: ThemeId;
  defaultCurrency: string | null;
  defaultCountry: string | null;
  defaultSearchMethod: 'ai' | 'manual';
  customBaseUrl: string | null;
  extractTimeoutSeconds: number;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  hasGoogleKey: boolean;
  vpnProvider: string | null;
  vpnCountries: string[];
  hasVpnActivationCode: boolean;
  aggregatorsEnabled: string[];
  anthropicRpm: number | null;
  googleRpm: number | null;
  openaiRpm: number | null;
  groqRpm: number | null;
  previewConcurrency: number | null;
  previewAdmissionCap: number | null;
  isSelfHosted: boolean;
}

const AGGREGATOR_OPTIONS = [
  { id: 'google_flights', label: 'Google Flights', experimental: false },
  { id: 'airline_direct', label: 'Airline direct', experimental: false },
  { id: 'skyscanner', label: 'Skyscanner', experimental: true },
  { id: 'kayak', label: 'Kayak', experimental: true },
] as const;



export default function ConfigPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('claude-haiku-4-5-20251001');
  const [customModel, setCustomModel] = useState('');
  const [scrapeInterval, setScrapeInterval] = useState(3);
  const [extractTimeoutSeconds, setExtractTimeoutSeconds] = useState(90);
  const [maxFlightsPerDate, setMaxFlightsPerDate] = useState(10);
  const [maxTrackedPerRoute, setMaxTrackedPerRoute] = useState(10);
  const [previewMaxCombos, setPreviewMaxCombos] = useState(24);
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const [defaultCurrency, setDefaultCurrency] = useState('');
  const [defaultCountry, setDefaultCountry] = useState('');
  const [defaultSearchMethod, setDefaultSearchMethod] = useState<'ai' | 'manual'>('ai');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  // Provider API key the admin types in (#149). Never pre-filled from the
  // server (keys never cross the wire); blank means "leave the saved key
  // unchanged". setProviderStatuses tracks readiness from /api/admin/providers.
  const [apiKey, setApiKey] = useState('');
  const [providerStatuses, setProviderStatuses] = useState<Record<string, string>>({});
  const [vpnProvider, setVpnProvider] = useState('none');
  const [vpnCountries, setVpnCountries] = useState<string[]>([]);
  const [aggregatorsEnabled, setAggregatorsEnabled] = useState<string[]>(['google_flights', 'airline_direct']);
  // Advanced perf knobs. Empty string = use the env var / built-in default.
  const [anthropicRpm, setAnthropicRpm] = useState('');
  const [googleRpm, setGoogleRpm] = useState('');
  const [openaiRpm, setOpenaiRpm] = useState('');
  const [groqRpm, setGroqRpm] = useState('');
  const [previewConcurrency, setPreviewConcurrency] = useState('');
  const [previewAdmissionCap, setPreviewAdmissionCap] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const [adminPassword, setAdminPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState('');

  const [localModels, setLocalModels] = useState<{ id: string; name: string; size: string }[]>([]);
  const [localModelsLoading, setLocalModelsLoading] = useState(false);
  const [localModelsError, setLocalModelsError] = useState('');

  const fetchLocalModels = useCallback((p: string) => {
    if (!LOCAL_PROVIDERS.has(p)) {
      setLocalModels([]);
      setLocalModelsError('');
      return;
    }
    setLocalModelsLoading(true);
    setLocalModelsError('');
    setLocalModels([]); // clear stale data to avoid showing old list during fetch
    fetch(`/api/admin/local-models?provider=${p}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setLocalModels(d.data);
        } else {
          setLocalModels([]);
          setLocalModelsError(d.error || 'Failed to fetch models');
        }
      })
      .catch(() => {
        setLocalModels([]);
        setLocalModelsError('Could not connect');
      })
      .finally(() => setLocalModelsLoading(false));
  }, []);

  // Real-time readiness per provider (ready / no_key / unreachable / not_installed)
  // so the admin can see which providers will actually work (#149).
  const fetchProviderStatuses = useCallback(() => {
    fetch('/api/admin/providers')
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) return;
        const map: Record<string, string> = {};
        for (const [key, s] of Object.entries(d.data as Record<string, { status: string }>)) {
          map[key] = s.status;
        }
        setProviderStatuses(map);
      })
      .catch(() => { /* readiness is advisory; ignore fetch errors */ });
  }, []);

  useEffect(() => {
    fetchProviderStatuses();
  }, [fetchProviderStatuses]);

  useEffect(() => {
    fetch('/api/admin/config')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setConfig(d.data);
          setProvider(d.data.provider);
          setScrapeInterval(d.data.scrapeInterval);
          setExtractTimeoutSeconds(d.data.extractTimeoutSeconds ?? 90);
          setMaxFlightsPerDate(d.data.maxFlightsPerDate ?? 10);
          setMaxTrackedPerRoute(d.data.maxTrackedPerRoute ?? 10);
          setPreviewMaxCombos(d.data.previewMaxCombos ?? 24);
          setTheme(isThemeId(d.data.theme) ? d.data.theme : DEFAULT_THEME);
          setDefaultCurrency(d.data.defaultCurrency || '');
          setDefaultCountry(d.data.defaultCountry || '');
          setDefaultSearchMethod(d.data.defaultSearchMethod === 'manual' ? 'manual' : 'ai');
          setCustomBaseUrl(d.data.customBaseUrl || '');
          setVpnProvider(d.data.vpnProvider || 'none');
          setVpnCountries(d.data.vpnCountries || []);
          setAggregatorsEnabled(d.data.aggregatorsEnabled ?? ['google_flights', 'airline_direct']);
          setAnthropicRpm(String(d.data.anthropicRpm ?? ''));
          setGoogleRpm(String(d.data.googleRpm ?? ''));
          setOpenaiRpm(String(d.data.openaiRpm ?? ''));
          setGroqRpm(String(d.data.groqRpm ?? ''));
          setPreviewConcurrency(String(d.data.previewConcurrency ?? ''));
          setPreviewAdmissionCap(String(d.data.previewAdmissionCap ?? ''));
          const pc = PROVIDER_METADATA[d.data.provider];
          const knownModel = pc?.models.find((m) => m.id === d.data.model);
          if (knownModel) {
            setModel(d.data.model);
            setCustomModel('');
          } else {
            setModel(pc?.models[0]?.id ?? '');
            setCustomModel(d.data.model);
          }
          fetchLocalModels(d.data.provider);
        }
      });
  }, [fetchLocalModels]);

  const providerConfig = PROVIDER_METADATA[provider];
  const models = providerConfig?.models ?? [];
  // Whether a key is already stored for the selected provider (from the GET
  // booleans) and its live readiness, to drive the API-key field's hint (#149).
  const hasStoredKey =
    provider === 'anthropic' ? !!config?.hasAnthropicKey
    : provider === 'openai' ? !!config?.hasOpenaiKey
    : provider === 'google' ? !!config?.hasGoogleKey
    : false;
  const providerStatus = providerStatuses[provider];
  const STATUS_LABEL: Record<string, string> = {
    ready: 'Ready',
    no_key: 'No key configured',
    unreachable: 'Not reachable',
    not_installed: 'Not installed',
  };

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    setCustomModel('');
    // Clear the key field so a key typed for one provider can't be saved
    // against another. The saved key (if any) stays in the DB untouched.
    setApiKey('');
    // Leave the base URL empty so the default is only a placeholder, not a saved
    // value. Persisting the localhost default would be stored as customBaseUrl,
    // which overrides the OLLAMA_HOST env that install.sh sets to
    // host.docker.internal, breaking Ollama in Docker. Issue #139 follow-up.
    setCustomBaseUrl('');
    const newModels = PROVIDER_METADATA[newProvider]?.models ?? [];
    if (newModels.length > 0) {
      setModel(newModels[0]!.id);
    } else {
      setModel('');
    }
    fetchLocalModels(newProvider);
  };

  const effectiveModel = customModel.trim() || model || (localModels.length > 0 ? localModels[0]!.id : '');

  const handleSave = async () => {
    if (!effectiveModel) {
      setMessage('Enter a model ID before saving');
      return;
    }
    setSaving(true);
    setMessage('');

    const newBaseUrl = customBaseUrl.trim() || null;
    // apiKey: a blank field is sent as undefined (dropped by JSON.stringify) so
    // it leaves the saved key untouched; only a typed value is stored (#149).
    const res = await fetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model: effectiveModel,
        scrapeIntervalHours: scrapeInterval,
        extractTimeoutSeconds,
        maxFlightsPerDate,
        maxTrackedPerRoute,
        previewMaxCombos,
        theme,
        defaultCurrency: defaultCurrency.trim().toUpperCase() || null,
        defaultCountry: defaultCountry.trim().toUpperCase() || null,
        defaultSearchMethod,
        customBaseUrl: newBaseUrl,
        apiKey: apiKey.trim() || undefined,
        vpnProvider: vpnProvider === 'none' ? null : vpnProvider,
        vpnCountries,
        aggregatorsEnabled,
        anthropicRpm: anthropicRpm.trim() === '' ? null : Number(anthropicRpm),
        googleRpm: googleRpm.trim() === '' ? null : Number(googleRpm),
        openaiRpm: openaiRpm.trim() === '' ? null : Number(openaiRpm),
        groqRpm: groqRpm.trim() === '' ? null : Number(groqRpm),
        previewConcurrency: previewConcurrency.trim() === '' ? null : Number(previewConcurrency),
        previewAdmissionCap: previewAdmissionCap.trim() === '' ? null : Number(previewAdmissionCap),
      }),
    });

    const data = await res.json();
    if (data.ok) {
      setConfig(data.data);
      setMessage('Config saved');
      // Clear the typed key and refresh readiness now that it's stored.
      setApiKey('');
      fetchProviderStatuses();
      // Re-fetch models if the base URL changed (cache key includes host)
      if (LOCAL_PROVIDERS.has(provider)) {
        fetchLocalModels(provider);
      }
    } else {
      setMessage(data.error || 'Failed to save');
    }
    setSaving(false);
  };

  const handleSavePassword = async () => {
    if (!adminPassword) return;
    setSavingPassword(true);
    setPasswordMessage('');

    const res = await fetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword }),
    });

    const data = await res.json();
    if (data.ok) {
      setConfig(data.data);
      setAdminPassword('');
      setPasswordMessage('Password updated');
    } else {
      setPasswordMessage(data.error || 'Failed to save');
    }
    setSavingPassword(false);
  };

  if (!config) {
    return <div className={styles.root}><p className={styles.loading}>Loading config...</p></div>;
  }

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Extraction Config</h1>

      <div className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label}>Provider</label>
          <select
            className={styles.select}
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            {Object.entries(PROVIDER_METADATA).map(([key, p]) => (
              <option key={key} value={key}>{p.displayName}</option>
            ))}
          </select>
          {providerStatus && (
            <span className={`${styles.toggleHint} ${providerStatus === 'ready' ? styles.statusReady : styles.statusNotReady}`}>
              Status: {STATUS_LABEL[providerStatus] ?? providerStatus}
            </span>
          )}
          {(provider === 'claude-code' || provider === 'codex') && (
            <div className={styles.info}>
              <div className={styles.infoTitle}>Security note</div>
              <div className={styles.infoText}>
                {provider === 'codex'
                  ? 'Codex runs an agentic CLI to read scraped pages. It is pinned to a read-only sandbox, but an agentic CLI can still read local files, so a crafted page could read (not write or execute) host data. The page is sanitized and fenced as untrusted first. For the strongest isolation, prefer an API provider.'
                  : 'Claude Code runs a local CLI to read scraped pages, locked to text-only inference with every tool disabled, so scraped page content cannot trigger file or command access.'}
              </div>
            </div>
          )}
        </div>

        {providerConfig?.envKey && (
          <div className={styles.field}>
            <label className={styles.label}>API Key</label>
            <input
              type="password"
              className={styles.input}
              autoComplete="off"
              placeholder={hasStoredKey ? 'Saved — paste a new key to replace' : `Paste your ${providerConfig.displayName} API key`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <span className={styles.toggleHint}>
              {hasStoredKey
                ? `A key is saved. Leave blank to keep it, or paste a new one to replace it. Stored encrypted; falls back to the ${providerConfig.envKey} environment variable.`
                : `Paste a key to store it (encrypted) here, or set the ${providerConfig.envKey} environment variable. No restart needed.`}
            </span>
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label}>Model</label>
          {models.length > 0 && (
            <select
              className={styles.select}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.costPer1kInput === 0 ? 'Free (Max)' : `$${m.costPer1kInput}/1k in`})
                </option>
              ))}
            </select>
          )}
          {models.length === 0 && localModels.length > 0 && (
            <select
              className={styles.select}
              value={customModel || localModels[0]!.id}
              onChange={(e) => setCustomModel(e.target.value)}
            >
              {localModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.size ? ` (${m.size})` : ''}
                </option>
              ))}
            </select>
          )}
          {models.length === 0 && localModelsLoading && (
            <span className={styles.modelHint}>Fetching models...</span>
          )}
          {models.length === 0 && localModelsError && (
            <span className={styles.modelHintError}>{localModelsError}</span>
          )}
          {providerConfig?.allowCustomModel && (
            <input
              type="text"
              className={styles.input}
              placeholder={models.length === 0 && localModels.length === 0
                ? 'Model ID (e.g. llama3.1:8b, mistral:7b)'
                : 'Or type a custom model ID'}
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
            />
          )}
        </div>

        {providerConfig?.allowCustomBaseUrl && (
          <div className={styles.field}>
            <label className={styles.label}>API Base URL</label>
            <input
              type="url"
              className={styles.input}
              placeholder={providerConfig.defaultBaseUrl || 'https://...'}
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
            />
            <span className={styles.toggleHint}>
              {providerConfig.defaultBaseUrl
                ? `Default: ${providerConfig.defaultBaseUrl}`
                : 'Leave empty for default'}
            </span>
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label}>Scrape Interval</label>
          <select
            className={styles.select}
            value={scrapeInterval}
            onChange={(e) => setScrapeInterval(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
              <option key={h} value={h}>Every {h}h</option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Extraction Timeout (seconds)</label>
          <input
            type="number"
            className={styles.input}
            min={30}
            max={600}
            step={1}
            value={extractTimeoutSeconds}
            onChange={(e) => setExtractTimeoutSeconds(Number(e.target.value))}
          />
          <span className={styles.toggleHint}>
            Default 90. Raise this for slow CPU bound local models that exceed the default and time out.
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Max flights per date</label>
          <input
            type="number"
            className={styles.input}
            min={5}
            max={50}
            step={1}
            value={maxFlightsPerDate}
            onChange={(e) => setMaxFlightsPerDate(Number(e.target.value))}
          />
          <span className={styles.toggleHint}>
            Default 10. Raise to 20-30 for busy routes (JFK-LAX, LHR-CDG) where 10 flights may miss afternoon or budget options. Higher values use more LLM output tokens per scrape.
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Max tracked flights per route</label>
          <input
            type="number"
            className={styles.input}
            min={1}
            max={50}
            step={1}
            value={maxTrackedPerRoute}
            onChange={(e) => setMaxTrackedPerRoute(Number(e.target.value))}
          />
          <span className={styles.toggleHint}>
            Default 10. How many flights a user can select to track from one route in the results picker. The selection is also bounded by Max flights per date, since you can only pick from the flights that were extracted.
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Max preview combinations</label>
          <input
            type="number"
            className={styles.input}
            min={6}
            max={96}
            step={1}
            value={previewMaxCombos}
            onChange={(e) => setPreviewMaxCombos(Number(e.target.value))}
          />
          <span className={styles.toggleHint}>
            Default 24. Caps routes x dates for the create-time preview scrape only; the recurring cron always covers the full grid. Raise it for wide multi-airport flex searches, but each combination is a live page load, so higher values make creating a tracker slower.
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Theme (instance default)</label>
          <ThemePicker value={theme} onSelect={(id) => setTheme(id)} />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Default Currency (ISO 4217)</label>
          <input
            type="text"
            className={styles.input}
            placeholder="e.g. EUR, GBP — empty = auto-detect"
            value={defaultCurrency}
            onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())}
            maxLength={3}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Default Country (ISO 3166-1)</label>
          <input
            type="text"
            className={styles.input}
            placeholder="e.g. DE, GB — empty = auto-detect"
            value={defaultCountry}
            onChange={(e) => setDefaultCountry(e.target.value.toUpperCase())}
            maxLength={2}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Default Search Method</label>
          <select
            className={styles.select}
            value={defaultSearchMethod}
            onChange={(e) => setDefaultSearchMethod(e.target.value as 'ai' | 'manual')}
          >
            <option value="ai">AI natural language search</option>
            <option value="manual">Manual input form</option>
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Aggregator Sources</label>
          <div>
            {AGGREGATOR_OPTIONS.map((opt) => {
              const checked = aggregatorsEnabled.includes(opt.id);
              return (
                <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0' }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setAggregatorsEnabled([...aggregatorsEnabled, opt.id]);
                      } else {
                        setAggregatorsEnabled(aggregatorsEnabled.filter((s) => s !== opt.id));
                      }
                    }}
                  />
                  <span>{opt.label}</span>
                  {opt.experimental && (
                    <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.05em' }}>
                      experimental
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          <span className={styles.toggleHint}>
            Sources allowed in the per-query aggregator chain. Skyscanner and Kayak are best-effort, gated by aggressive anti-bot protection on those sites.
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Provider rate limits (advanced)</label>
          <span className={styles.toggleHint}>
            Requests per minute per provider. Leave blank to use the conservative free tier defaults (Anthropic 50, Google 15, OpenAI 60, Groq 30). Raise these to match a paid API tier; lower them to stay under a quota.
          </span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Anthropic RPM</label>
          <input type="number" className={styles.input} min={1} placeholder="default 50" value={anthropicRpm} onChange={(e) => setAnthropicRpm(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Google / Gemini RPM</label>
          <input type="number" className={styles.input} min={1} placeholder="default 15" value={googleRpm} onChange={(e) => setGoogleRpm(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>OpenAI RPM</label>
          <input type="number" className={styles.input} min={1} placeholder="default 60" value={openaiRpm} onChange={(e) => setOpenaiRpm(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Groq RPM</label>
          <input type="number" className={styles.input} min={1} placeholder="default 30" value={groqRpm} onChange={(e) => setGroqRpm(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Preview concurrency</label>
          <input type="number" className={styles.input} min={1} max={10} placeholder="default 3" value={previewConcurrency} onChange={(e) => setPreviewConcurrency(e.target.value)} />
          <span className={styles.toggleHint}>
            Parallel browser instances for the create-time preview scrape. Higher is faster but uses more memory. Leave blank for the default (3).
          </span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Preview admission cap per IP</label>
          <input type="number" className={styles.input} min={1} max={50} placeholder="default 3" value={previewAdmissionCap} onChange={(e) => setPreviewAdmissionCap(e.target.value)} />
          <span className={styles.toggleHint}>
            Max preview runs one client can have in flight at once. Leave blank for the default (3).
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Scraping</label>
          <div className={styles.toggleRow}>
            <button
              type="button"
              className={`${styles.toggle} ${config.enabled ? styles.toggleOn : ''}`}
              onClick={async () => {
                const newValue = !config.enabled;
                const res = await fetch('/api/admin/config', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ enabled: newValue }),
                });
                const data = await res.json();
                if (data.ok) setConfig(data.data);
              }}
            >
              <span className={styles.toggleKnob} />
            </button>
            <div>
              <span className={styles.toggleLabel}>
                {config.enabled ? 'Scraping enabled' : 'Scraping paused'}
              </span>
              <p className={styles.toggleHint}>
                Pause to stop all background price checks, for example while away or over an API quota. Existing trackers and price history are kept.
              </p>
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.saveButton} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Config'}
          </button>
          {message && <span className={styles.message}>{message}</span>}
        </div>
      </div>


      <div className={styles.form}>
        <h2 className={styles.sectionTitle}>Admin Password</h2>

        <div className={styles.field}>
          <label className={styles.label}>
            Password {config.hasAdminPassword && <span className={styles.passwordSet}>(set)</span>}
          </label>
          <input
            type="password"
            className={styles.input}
            placeholder={config.hasAdminPassword ? 'Leave blank to keep current' : 'Set admin password'}
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
          />
        </div>

        <div className={styles.actions}>
          <button className={styles.saveButton} onClick={handleSavePassword} disabled={savingPassword || !adminPassword}>
            {savingPassword ? 'Saving...' : 'Save Password'}
          </button>
          {passwordMessage && <span className={styles.message}>{passwordMessage}</span>}
        </div>
      </div>

      <div className={styles.form}>
        <h2 className={styles.sectionTitle}>Community Data Sharing</h2>

        <p className={styles.toggleHint}>
          Flight Finder gets better when instances pool their price history. Turn on
          sharing to contribute your anonymized data points (route, price, airline,
          and date only, never anything personal) to a shared fare dataset everyone
          can explore, and in return you see community prices on routes you have not
          scraped yourself. It is fully opt-in and you can turn it off any time.
        </p>

        <div className={styles.toggleRow}>
          <button
            type="button"
            className={`${styles.toggle} ${config.communitySharing ? styles.toggleOn : ''}`}
            onClick={async () => {
              const newValue = !config.communitySharing;
              const res = await fetch('/api/admin/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ communitySharing: newValue }),
              });
              const data = await res.json();
              if (data.ok) setConfig(data.data);
            }}
          >
            <span className={styles.toggleKnob} />
          </button>
          <div>
            <span className={styles.toggleLabel}>
              {config.communitySharing ? 'Sharing enabled' : 'Sharing disabled'}
            </span>
            <p className={styles.toggleHint}>
              Contribute this instance&apos;s anonymized prices (route, price, airline, date) to the community dataset.
            </p>
          </div>
        </div>

        {/* Hub side: only the hosted flight-finder.org instance accepts
            registrations from other instances, so hide this on self-hosted. */}
        {!config.isSelfHosted && (
          <div className={styles.toggleRow}>
            <button
              type="button"
              className={`${styles.toggle} ${config.communityRegistrationOpen ? styles.toggleOn : ''}`}
              onClick={async () => {
                const newValue = !config.communityRegistrationOpen;
                const res = await fetch('/api/admin/config', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ communityRegistrationOpen: newValue }),
                });
                const data = await res.json();
                if (data.ok) setConfig(data.data);
              }}
            >
              <span className={styles.toggleKnob} />
            </button>
            <div>
              <span className={styles.toggleLabel}>
                Run a hub: {config.communityRegistrationOpen ? 'accepting contributors' : 'closed'}
              </span>
              <p className={styles.toggleHint}>
                Lets other Flight Finder instances register with this one and send their
                anonymized data here. Only relevant for the central hub. New registrations
                are rate limited and globally capped.
              </p>
            </div>
          </div>
        )}

        {config.communityApiKey && (
          <div className={styles.field}>
            <label className={styles.label}>API Key</label>
            <code className={styles.code}>
              {config.communityApiKey.slice(0, 8)}...{config.communityApiKey.slice(-4)}
            </code>
          </div>
        )}
      </div>

      <div className={styles.info}>
        <h2 className={styles.infoTitle}>Provider Details</h2>
        <p className={styles.infoText}>
          <strong>API key:</strong>{' '}
          {providerConfig?.envKey ? (
            <>
              entered above (stored encrypted), or read from{' '}
              <code className={styles.code}>{providerConfig.envKey}</code> if none is set
            </>
          ) : (
            'not required — this provider signs in through its local CLI, no API key needed'
          )}
        </p>
        <p className={styles.infoText}>
          <strong>Models available:</strong> {models.length}
        </p>
      </div>
    </div>
  );
}
