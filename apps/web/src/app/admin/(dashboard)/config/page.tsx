'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('AdminConfig');
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
    const fetchFailed = t('modelsFetchFailed');
    const couldNotConnect = t('modelsCouldNotConnect');
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
          setLocalModelsError(d.error || fetchFailed);
        }
      })
      .catch(() => {
        setLocalModels([]);
        setLocalModelsError(couldNotConnect);
      })
      .finally(() => setLocalModelsLoading(false));
  }, [t]);

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
    ready: t('providerStatus.ready'),
    no_key: t('providerStatus.noKey'),
    unreachable: t('providerStatus.unreachable'),
    not_installed: t('providerStatus.notInstalled'),
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
      setMessage(t('enterModelId'));
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
      setMessage(t('configSaved'));
      // Clear the typed key and refresh readiness now that it's stored.
      setApiKey('');
      fetchProviderStatuses();
      // Re-fetch models if the base URL changed (cache key includes host)
      if (LOCAL_PROVIDERS.has(provider)) {
        fetchLocalModels(provider);
      }
    } else {
      setMessage(data.error || t('failedToSave'));
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
      setPasswordMessage(t('passwordUpdated'));
    } else {
      setPasswordMessage(data.error || t('failedToSave'));
    }
    setSavingPassword(false);
  };

  if (!config) {
    return <div className={styles.root}><p className={styles.loading}>{t('loading')}</p></div>;
  }

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>{t('title')}</h1>

      <div className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label}>{t('provider')}</label>
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
              {t('status', { status: STATUS_LABEL[providerStatus] ?? providerStatus })}
            </span>
          )}
          {(provider === 'claude-code' || provider === 'codex') && (
            <div className={styles.info}>
              <div className={styles.infoTitle}>{t('securityNote')}</div>
              <div className={styles.infoText}>
                {provider === 'codex' ? t('codexNote') : t('claudeCodeNote')}
              </div>
            </div>
          )}
        </div>

        {providerConfig?.envKey && (
          <div className={styles.field}>
            <label className={styles.label}>{t('apiKey')}</label>
            <input
              type="password"
              className={styles.input}
              autoComplete="off"
              placeholder={hasStoredKey ? t('apiKeySavedPlaceholder') : t('apiKeyPlaceholder', { provider: providerConfig.displayName })}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <span className={styles.toggleHint}>
              {hasStoredKey
                ? t('apiKeySavedHint', { envKey: providerConfig.envKey })
                : t('apiKeyNewHint', { envKey: providerConfig.envKey })}
            </span>
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label}>{t('model')}</label>
          {models.length > 0 && (
            <select
              className={styles.select}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.costPer1kInput === 0 ? t('modelCostFree') : t('modelCost', { cost: m.costPer1kInput })})
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
            <span className={styles.modelHint}>{t('fetchingModels')}</span>
          )}
          {models.length === 0 && localModelsError && (
            <span className={styles.modelHintError}>{localModelsError}</span>
          )}
          {providerConfig?.allowCustomModel && (
            <input
              type="text"
              className={styles.input}
              placeholder={models.length === 0 && localModels.length === 0
                ? t('customModelPlaceholderEmpty')
                : t('customModelPlaceholder')}
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
            />
          )}
        </div>

        {providerConfig?.allowCustomBaseUrl && (
          <div className={styles.field}>
            <label className={styles.label}>{t('apiBaseUrl')}</label>
            <input
              type="url"
              className={styles.input}
              placeholder={providerConfig.defaultBaseUrl || 'https://...'}
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
            />
            <span className={styles.toggleHint}>
              {providerConfig.defaultBaseUrl
                ? t('baseUrlDefault', { url: providerConfig.defaultBaseUrl })
                : t('baseUrlEmptyHint')}
            </span>
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label}>{t('scrapeInterval')}</label>
          <select
            className={styles.select}
            value={scrapeInterval}
            onChange={(e) => setScrapeInterval(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
              <option key={h} value={h}>{t('everyHours', { hours: h })}</option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('extractionTimeout')}</label>
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
            {t('extractionTimeoutHint')}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('maxFlightsPerDate')}</label>
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
            {t('maxFlightsPerDateHint')}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('maxTrackedPerRoute')}</label>
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
            {t('maxTrackedPerRouteHint')}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('maxPreviewCombos')}</label>
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
            {t('maxPreviewCombosHint')}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('themeLabel')}</label>
          <ThemePicker value={theme} onSelect={(id) => setTheme(id)} />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('defaultCurrency')}</label>
          <input
            type="text"
            className={styles.input}
            placeholder={t('defaultCurrencyPlaceholder')}
            value={defaultCurrency}
            onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())}
            maxLength={3}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('defaultCountry')}</label>
          <input
            type="text"
            className={styles.input}
            placeholder={t('defaultCountryPlaceholder')}
            value={defaultCountry}
            onChange={(e) => setDefaultCountry(e.target.value.toUpperCase())}
            maxLength={2}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('defaultSearchMethod')}</label>
          <select
            className={styles.select}
            value={defaultSearchMethod}
            onChange={(e) => setDefaultSearchMethod(e.target.value as 'ai' | 'manual')}
          >
            <option value="ai">{t('searchMethodAi')}</option>
            <option value="manual">{t('searchMethodManual')}</option>
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('aggregatorSources')}</label>
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
                      {t('experimental')}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          <span className={styles.toggleHint}>
            {t('aggregatorsHint')}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('rateLimits')}</label>
          <span className={styles.toggleHint}>
            {t('rateLimitsHint')}
          </span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('anthropicRpm')}</label>
          <input type="number" className={styles.input} min={1} placeholder={t('defaultPlaceholder', { value: 50 })} value={anthropicRpm} onChange={(e) => setAnthropicRpm(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('googleRpm')}</label>
          <input type="number" className={styles.input} min={1} placeholder={t('defaultPlaceholder', { value: 15 })} value={googleRpm} onChange={(e) => setGoogleRpm(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('openaiRpm')}</label>
          <input type="number" className={styles.input} min={1} placeholder={t('defaultPlaceholder', { value: 60 })} value={openaiRpm} onChange={(e) => setOpenaiRpm(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('groqRpm')}</label>
          <input type="number" className={styles.input} min={1} placeholder={t('defaultPlaceholder', { value: 30 })} value={groqRpm} onChange={(e) => setGroqRpm(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('previewConcurrency')}</label>
          <input type="number" className={styles.input} min={1} max={10} placeholder={t('defaultPlaceholder', { value: 3 })} value={previewConcurrency} onChange={(e) => setPreviewConcurrency(e.target.value)} />
          <span className={styles.toggleHint}>
            {t('previewConcurrencyHint')}
          </span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('previewAdmissionCap')}</label>
          <input type="number" className={styles.input} min={1} max={50} placeholder={t('defaultPlaceholder', { value: 3 })} value={previewAdmissionCap} onChange={(e) => setPreviewAdmissionCap(e.target.value)} />
          <span className={styles.toggleHint}>
            {t('previewAdmissionCapHint')}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>{t('scraping')}</label>
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
                {config.enabled ? t('scrapingEnabled') : t('scrapingPaused')}
              </span>
              <p className={styles.toggleHint}>
                {t('scrapingHint')}
              </p>
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.saveButton} onClick={handleSave} disabled={saving}>
            {saving ? t('saving') : t('saveConfig')}
          </button>
          {message && <span className={styles.message}>{message}</span>}
        </div>
      </div>


      <div className={styles.form}>
        <h2 className={styles.sectionTitle}>{t('adminPassword')}</h2>

        <div className={styles.field}>
          <label className={styles.label}>
            {t('password')} {config.hasAdminPassword && <span className={styles.passwordSet}>{t('passwordSet')}</span>}
          </label>
          <input
            type="password"
            className={styles.input}
            placeholder={config.hasAdminPassword ? t('passwordKeepPlaceholder') : t('passwordSetPlaceholder')}
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
          />
        </div>

        <div className={styles.actions}>
          <button className={styles.saveButton} onClick={handleSavePassword} disabled={savingPassword || !adminPassword}>
            {savingPassword ? t('saving') : t('savePassword')}
          </button>
          {passwordMessage && <span className={styles.message}>{passwordMessage}</span>}
        </div>
      </div>

      <div className={styles.form}>
        <h2 className={styles.sectionTitle}>{t('communityTitle')}</h2>

        <p className={styles.toggleHint}>
          {t('communityIntro')}
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
              {config.communitySharing ? t('sharingEnabled') : t('sharingDisabled')}
            </span>
            <p className={styles.toggleHint}>
              {t('sharingHint')}
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
                {config.communityRegistrationOpen ? t('hubAccepting') : t('hubClosed')}
              </span>
              <p className={styles.toggleHint}>
                {t('hubHint')}
              </p>
            </div>
          </div>
        )}

        {config.communityApiKey && (
          <div className={styles.field}>
            <label className={styles.label}>{t('apiKey')}</label>
            <code className={styles.code}>
              {config.communityApiKey.slice(0, 8)}...{config.communityApiKey.slice(-4)}
            </code>
          </div>
        )}
      </div>

      <div className={styles.info}>
        <h2 className={styles.infoTitle}>{t('providerDetails')}</h2>
        <p className={styles.infoText}>
          <strong>{t('apiKeyDetail')}</strong>{' '}
          {providerConfig?.envKey ? (
            t.rich('apiKeyFromEnv', {
              envKey: providerConfig.envKey,
              code: (chunks) => <code className={styles.code}>{chunks}</code>,
            })
          ) : (
            t('apiKeyNotRequired')
          )}
        </p>
        <p className={styles.infoText}>
          <strong>{t('modelsAvailable')}</strong> {models.length}
        </p>
      </div>
    </div>
  );
}
