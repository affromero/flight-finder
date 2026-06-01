'use client';

import { useState, useEffect, useCallback } from 'react';
import { EXTRACTION_PROVIDERS, LOCAL_PROVIDERS } from '@/lib/scraper/ai-registry';
import { THEME_OPTIONS, applyTheme, type ThemeId } from '@/lib/theme';
import styles from './page.module.css';

interface Config {
  provider: string;
  model: string;
  enabled: boolean;
  scrapeInterval: number;
  hasAdminPassword: boolean;
  communitySharing: boolean;
  communityApiKey: string | null;
  theme: ThemeId;
  defaultCurrency: string | null;
  defaultCountry: string | null;
  defaultSearchMethod: 'ai' | 'manual';
  customBaseUrl: string | null;
  extractTimeoutSeconds: number;
  vpnProvider: string | null;
  vpnCountries: string[];
  hasVpnActivationCode: boolean;
  aggregatorsEnabled: string[];
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
  const [theme, setTheme] = useState<ThemeId>('default');
  const [defaultCurrency, setDefaultCurrency] = useState('');
  const [defaultCountry, setDefaultCountry] = useState('');
  const [defaultSearchMethod, setDefaultSearchMethod] = useState<'ai' | 'manual'>('ai');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [vpnProvider, setVpnProvider] = useState('none');
  const [vpnCountries, setVpnCountries] = useState<string[]>([]);
  const [aggregatorsEnabled, setAggregatorsEnabled] = useState<string[]>(['google_flights', 'airline_direct']);
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
          setTheme(d.data.theme || 'default');
          applyTheme(d.data.theme || 'default');
          setDefaultCurrency(d.data.defaultCurrency || '');
          setDefaultCountry(d.data.defaultCountry || '');
          setDefaultSearchMethod(d.data.defaultSearchMethod === 'manual' ? 'manual' : 'ai');
          setCustomBaseUrl(d.data.customBaseUrl || '');
          setVpnProvider(d.data.vpnProvider || 'none');
          setVpnCountries(d.data.vpnCountries || []);
          setAggregatorsEnabled(d.data.aggregatorsEnabled ?? ['google_flights', 'airline_direct']);
          const pc = EXTRACTION_PROVIDERS[d.data.provider];
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

  const providerConfig = EXTRACTION_PROVIDERS[provider];
  const models = providerConfig?.models ?? [];

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    setCustomModel('');
    setCustomBaseUrl(EXTRACTION_PROVIDERS[newProvider]?.defaultBaseUrl ?? '');
    const newModels = EXTRACTION_PROVIDERS[newProvider]?.models ?? [];
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
        vpnProvider: vpnProvider === 'none' ? null : vpnProvider,
        vpnCountries,
        aggregatorsEnabled,
      }),
    });

    const data = await res.json();
    if (data.ok) {
      setConfig(data.data);
      setMessage('Config saved');
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
            {Object.entries(EXTRACTION_PROVIDERS).map(([key, p]) => (
              <option key={key} value={key}>{p.displayName}</option>
            ))}
          </select>
        </div>

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
          <label className={styles.label}>Theme</label>
          <select
            className={styles.select}
            value={theme}
            onChange={(e) => {
              const nextTheme = e.target.value as ThemeId;
              setTheme(nextTheme);
              applyTheme(nextTheme);
            }}
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
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
          <label className={styles.label}>Status</label>
          <span className={config.enabled ? styles.enabled : styles.disabled}>
            {config.enabled ? 'Enabled' : 'Disabled'}
          </span>
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
              Share anonymized price data (route, price, airline, date) with the Flight Finder community.
            </p>
          </div>
        </div>

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
          <strong>Env key:</strong>{' '}
          <code className={styles.code}>{providerConfig?.envKey ?? 'N/A'}</code>
        </p>
        <p className={styles.infoText}>
          <strong>Available models:</strong> {models.length}
        </p>
      </div>
    </div>
  );
}
