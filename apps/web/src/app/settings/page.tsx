'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AvatarPicker } from '@/components/AvatarPicker/AvatarPicker';
import { ThemePicker } from '@/components/ThemePicker/ThemePicker';
import { ReachGuide } from '@/components/ReachGuide/ReachGuide';
import { PROVIDER_METADATA, LOCAL_PROVIDERS, CLI_PROVIDERS } from '@/lib/scraper/provider-metadata';
import { isThemeId, DEFAULT_THEME, type ThemeId } from '@/lib/theme';
import styles from './page.module.css';

interface Config {
  provider: string;
  model: string;
  enabled: boolean;
  scrapeInterval: number;
  communitySharing: boolean;
  communityRegistrationOpen: boolean;
  communityApiKey: string | null;
  customBaseUrl: string | null;
  publicBaseUrl: string | null;
  theme: ThemeId;
  defaultCurrency: string | null;
  defaultCountry: string | null;
  defaultSearchMethod: 'ai' | 'manual';
  vpnProvider: string | null;
  vpnCountries: string[];
  hasVpnActivationCode: boolean;
  multiUserMode: boolean;
  isSelfHosted: boolean;
}

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('claude-haiku-4-5-20251001');
  const [customModel, setCustomModel] = useState('');
  const [scrapeInterval, setScrapeInterval] = useState(3);
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [reachSaving, setReachSaving] = useState(false);
  const [reachMessage, setReachMessage] = useState('');
  const [defaultCurrency, setDefaultCurrency] = useState('');
  const [defaultCountry, setDefaultCountry] = useState('');
  const [defaultSearchMethod, setDefaultSearchMethod] = useState<'ai' | 'manual'>('ai');
  const [vpnProvider, setVpnProvider] = useState('none');
  const [vpnCountries, setVpnCountries] = useState<string[]>([]);
  const [vpnActivationCode, setVpnActivationCode] = useState('');
  const [vpnCodeSaving, setVpnCodeSaving] = useState(false);
  const [vpnCodeMessage, setVpnCodeMessage] = useState('');
  const [hasVpnCode, setHasVpnCode] = useState(false);
  const [vpnLive, setVpnLive] = useState<{ configured: boolean; sidecarRunning: boolean; ready: boolean } | null>(null);
  const [detectedProviders, setDetectedProviders] = useState<string[]>([]);
  const [configuringProvider, setConfiguringProvider] = useState<string | null>(null);
  const [providerKeyInput, setProviderKeyInput] = useState('');
  const [providerKeySaving, setProviderKeySaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const [themeMessage, setThemeMessage] = useState('');

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
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((d) => { setDetectedProviders(d.detectedProviders ?? d.data?.detectedProviders ?? []); })
      .catch(() => {});

    fetch('/api/vpn/status')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setVpnLive(d.data); })
      .catch(() => {});

    fetch('/api/admin/config')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setConfig(d.data);
          setProvider(d.data.provider);
          setScrapeInterval(d.data.scrapeInterval);
          setCustomBaseUrl(d.data.customBaseUrl || '');
          setPublicBaseUrl(d.data.publicBaseUrl || '');
          setTheme(isThemeId(d.data.theme) ? d.data.theme : DEFAULT_THEME);
          setDefaultCurrency(d.data.defaultCurrency || '');
          setDefaultCountry(d.data.defaultCountry || '');
          setDefaultSearchMethod(d.data.defaultSearchMethod === 'manual' ? 'manual' : 'ai');
          setVpnProvider(d.data.vpnProvider || 'none');
          setVpnCountries(d.data.vpnCountries || []);
          setHasVpnCode(d.data.hasVpnActivationCode || false);
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

  // The #reach section renders only after config loads, so a /settings#reach
  // deep link (from the connect page) can't scroll to it on first paint. Scroll
  // once config is in.
  useEffect(() => {
    if (config && typeof window !== 'undefined' && window.location.hash === '#reach') {
      document.getElementById('reach')?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [config]);

  const providerConfig = PROVIDER_METADATA[provider];
  const models = providerConfig?.models ?? [];

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    setCustomModel('');
    setCustomBaseUrl(PROVIDER_METADATA[newProvider]?.defaultBaseUrl ?? '');
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

    const res = await fetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model: effectiveModel,
        scrapeIntervalHours: scrapeInterval,
        customBaseUrl: customBaseUrl.trim() || null,
        theme,
        defaultCurrency: defaultCurrency.trim().toUpperCase() || null,
        defaultCountry: defaultCountry.trim().toUpperCase() || null,
        defaultSearchMethod,
        vpnProvider: vpnProvider === 'none' ? null : vpnProvider,
        vpnCountries,
      }),
    });

    const data = await res.json();
    if (data.ok) {
      setConfig(data.data);
      setMessage('Saved');
      if (LOCAL_PROVIDERS.has(provider)) {
        fetchLocalModels(provider);
      }
    } else {
      setMessage(data.error || 'Failed to save');
    }
    setSaving(false);
  };

  if (!config) return null;

  return (
    <div className={styles.root}>
      <div className={styles.content}>
        <div className={styles.header}>
          <Link href="/" className={styles.backLink} title="Back to home">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h1 className={styles.title}>Settings</h1>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Appearance</h2>
          <p className={styles.toggleHint}>
            The default theme for this instance. Each signed-in member can override
            it with their own in Account settings.
          </p>

          <ThemePicker
            value={theme}
            onSelect={async (id) => {
              setTheme(id);
              setThemeMessage('Saving…');
              try {
                const res = await fetch('/api/admin/config', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ theme: id }),
                });
                const data = await res.json();
                setThemeMessage(data.ok ? 'Saved' : (data.error || 'Failed to save theme'));
                if (data.ok) setConfig(data.data);
              } catch {
                setThemeMessage('Failed to save theme');
              }
            }}
          />

          {themeMessage && <span className={styles.message}>{themeMessage}</span>}
        </div>

        {config.isSelfHosted && (
          <div className={styles.section} id="reach">
            <h2 className={styles.sectionTitle}>Reach it from other devices</h2>
            <p className={styles.toggleHint}>
              Flight Finder runs on this machine. Pick how you want to reach it from
              a phone or share it with the household, follow the steps, then paste
              the resulting URL below so QR codes and price-alert links use it.
            </p>
            <ReachGuide />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="publicBaseUrl">Public URL</label>
              <input
                id="publicBaseUrl"
                type="url"
                className={styles.input}
                placeholder="https://flights.yourdomain.org"
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
              />
              <span className={styles.toggleHint}>
                Leave empty to use the address each device connects on.
              </span>
            </div>
            <div className={styles.reachActions}>
              <button
                type="button"
                className={styles.button}
                disabled={reachSaving}
                onClick={async () => {
                  setReachSaving(true);
                  setReachMessage('');
                  try {
                    const res = await fetch('/api/admin/config', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ publicBaseUrl: publicBaseUrl.trim() || null }),
                    });
                    const data = await res.json();
                    setReachMessage(data.ok ? 'Saved' : (data.error || 'Failed to save'));
                  } catch {
                    setReachMessage('Failed to save');
                  } finally {
                    setReachSaving(false);
                  }
                }}
              >
                {reachSaving ? 'Saving…' : 'Save URL'}
              </button>
              <Link href="/connect" className={styles.secondaryLink}>Phone setup &amp; QR →</Link>
              {reachMessage && <span className={styles.message}>{reachMessage}</span>}
            </div>
          </div>
        )}

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Extraction</h2>

          <div className={styles.field}>
            <label className={styles.label}>Provider</label>
            <div className={styles.providerGrid}>
              {Object.entries(PROVIDER_METADATA).map(([key, p]) => {
                const detected = detectedProviders.includes(key);
                const isCli = !!CLI_PROVIDERS[key];
                const isLocal = LOCAL_PROVIDERS.has(key);
                return (
                  <div key={key} className={styles.providerCardWrapper}>
                    <button
                      type="button"
                      className={`${styles.providerCard} ${provider === key ? styles.providerCardSelected : ''} ${!detected && !isLocal ? styles.providerCardUnavailable : ''}`}
                      onClick={() => {
                        if (detected || isLocal) {
                          handleProviderChange(key);
                          setConfiguringProvider(null);
                        } else {
                          setConfiguringProvider(configuringProvider === key ? null : key);
                          setProviderKeyInput('');
                        }
                      }}
                    >
                      <span className={styles.providerCardName}>{p.displayName}</span>
                      <span className={styles.providerCardStatus}>
                        {detected
                          ? isCli ? 'Your subscription' : isLocal ? 'Local' : 'Ready'
                          : isCli ? 'Set up' : isLocal ? 'Local' : 'Add key'}
                      </span>
                    </button>
                    {configuringProvider === key && !detected && (
                      <div className={styles.providerConfigure}>
                        {isCli && key === 'claude-code' ? (
                          <>
                            <p className={styles.providerConfigHint}>
                              Run <code>claude setup-token</code> in your terminal, then paste the token:
                            </p>
                            <div className={styles.providerConfigRow}>
                              <input
                                type="password"
                                className={styles.input}
                                placeholder="Paste setup token"
                                value={providerKeyInput}
                                onChange={(e) => setProviderKeyInput(e.target.value)}
                                autoFocus
                              />
                              <button
                                className={styles.saveButton}
                                disabled={providerKeySaving || !providerKeyInput}
                                onClick={async () => {
                                  setProviderKeySaving(true);
                                  // TODO: save Claude Code setup token to container
                                  // For now, show instructions
                                  setProviderKeySaving(false);
                                  setMessage('Add CLAUDE_CODE_OAUTH_TOKEN to ~/.flight-finder/.env and restart');
                                  setConfiguringProvider(null);
                                }}
                              >
                                Save
                              </button>
                            </div>
                          </>
                        ) : isCli && key === 'codex' ? (
                          <>
                            <p className={styles.providerConfigHint}>
                              Codex CLI needs to be installed on the host. Run <code>npm i -g @openai/codex</code>.
                            </p>
                          </>
                        ) : (
                          <>
                            <p className={styles.providerConfigHint}>
                              Paste your {p.displayName} API key:
                            </p>
                            <div className={styles.providerConfigRow}>
                              <input
                                type="password"
                                className={styles.input}
                                placeholder={`${p.envKey}`}
                                value={providerKeyInput}
                                onChange={(e) => setProviderKeyInput(e.target.value)}
                                autoFocus
                              />
                              <button
                                className={styles.saveButton}
                                disabled={providerKeySaving || !providerKeyInput}
                                onClick={async () => {
                                  setProviderKeySaving(true);
                                  setMessage(`Add ${p.envKey}=${providerKeyInput.slice(0, 8)}... to ~/.flight-finder/.env and restart`);
                                  setProviderKeySaving(false);
                                  setConfiguringProvider(null);
                                  setProviderKeyInput('');
                                }}
                              >
                                Save
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
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
                    {m.name} ({m.costPer1kInput === 0 ? 'Free (CLI)' : `$${m.costPer1kInput}/1k in`})
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
                <option key={h} value={h}>Every {h} hour{h !== 1 ? 's' : ''}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Default Currency</label>
            <select
              className={styles.select}
              value={['', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'MXN', 'BRL', 'KRW', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'NZD', 'THB', 'COP', 'ARS'].includes(defaultCurrency) ? defaultCurrency : '_custom'}
              onChange={(e) => setDefaultCurrency(e.target.value === '_custom' ? '' : e.target.value)}
            >
              <option value="">Auto-detect</option>
              <option value="USD">USD - US Dollar</option>
              <option value="EUR">EUR - Euro</option>
              <option value="GBP">GBP - British Pound</option>
              <option value="JPY">JPY - Japanese Yen</option>
              <option value="CAD">CAD - Canadian Dollar</option>
              <option value="AUD">AUD - Australian Dollar</option>
              <option value="CHF">CHF - Swiss Franc</option>
              <option value="CNY">CNY - Chinese Yuan</option>
              <option value="INR">INR - Indian Rupee</option>
              <option value="MXN">MXN - Mexican Peso</option>
              <option value="BRL">BRL - Brazilian Real</option>
              <option value="KRW">KRW - South Korean Won</option>
              <option value="SGD">SGD - Singapore Dollar</option>
              <option value="HKD">HKD - Hong Kong Dollar</option>
              <option value="SEK">SEK - Swedish Krona</option>
              <option value="NOK">NOK - Norwegian Krone</option>
              <option value="DKK">DKK - Danish Krone</option>
              <option value="NZD">NZD - New Zealand Dollar</option>
              <option value="THB">THB - Thai Baht</option>
              <option value="COP">COP - Colombian Peso</option>
              <option value="ARS">ARS - Argentine Peso</option>
              <option value="_custom">Other...</option>
            </select>
            {!['', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'MXN', 'BRL', 'KRW', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'NZD', 'THB', 'COP', 'ARS'].includes(defaultCurrency) && (
              <input
                type="text"
                className={styles.input}
                placeholder="3-letter ISO 4217 code"
                value={defaultCurrency}
                onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())}
                maxLength={3}
              />
            )}
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
            <span className={styles.toggleHint}>
              Controls which search flow opens first on the home page for this Flight Finder instance.
            </span>
          </div>

          <div className={styles.actions}>
            <button className={styles.saveButton} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            {message && <span className={styles.message}>{message}</span>}
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>VPN Price Comparison</h2>
          <p className={styles.toggleHint}>
            Test the myth: do flight prices change based on your VPN location?
          </p>

          <div className={styles.vpnProviderGrid}>
            <button
              type="button"
              className={`${styles.vpnCard} ${vpnProvider === 'expressvpn' && hasVpnCode ? styles.vpnCardActive : ''}`}
              onClick={() => {
                if (!hasVpnCode) {
                  const el = document.getElementById('vpn-activation-input');
                  el?.focus();
                }
              }}
            >
              <div className={styles.vpnCardHeader}>
                <span className={styles.vpnCardName}>ExpressVPN</span>
                <span className={vpnLive?.ready ? styles.vpnCardStatusReady : hasVpnCode ? styles.vpnCardStatusWarn : styles.vpnCardStatusOff}>
                  {vpnLive?.ready ? 'Connected' : hasVpnCode ? (vpnLive?.sidecarRunning === false ? 'Sidecar offline' : 'Code saved') : 'Not set up'}
                </span>
              </div>
              <span className={styles.vpnCardDesc}>Docker sidecar with SOCKS5 proxy</span>
            </button>

            <div className={styles.vpnCardDisabled}>
              <div className={styles.vpnCardHeader}>
                <span className={styles.vpnCardName}>NordVPN</span>
                <span className={styles.vpnCardStatusOff}>Coming soon</span>
              </div>
              <span className={styles.vpnCardDesc}>WireGuard-based sidecar</span>
            </div>

            <div className={styles.vpnCardDisabled}>
              <div className={styles.vpnCardHeader}>
                <span className={styles.vpnCardName}>Mullvad</span>
                <span className={styles.vpnCardStatusOff}>Coming soon</span>
              </div>
              <span className={styles.vpnCardDesc}>Privacy-focused SOCKS5</span>
            </div>

            <div className={styles.vpnCardDisabled}>
              <div className={styles.vpnCardHeader}>
                <span className={styles.vpnCardName}>Custom Proxy</span>
                <span className={styles.vpnCardStatusOff}>Coming soon</span>
              </div>
              <span className={styles.vpnCardDesc}>SOCKS5/HTTP proxy URLs</span>
            </div>
          </div>

          <div className={styles.vpnActivation}>
            <label className={styles.label}>
              ExpressVPN Activation Code
              {hasVpnCode && <span className={styles.vpnCodeSaved}> (saved)</span>}
            </label>
            {hasVpnCode && !vpnActivationCode && (
              <div className={styles.vpnCodeMasked}>
                <span>{'*'.repeat(20)}</span>
                <button
                  type="button"
                  className={styles.vpnCodeChange}
                  onClick={() => {
                    const el = document.getElementById('vpn-activation-input') as HTMLInputElement;
                    el?.focus();
                  }}
                >
                  Change
                </button>
              </div>
            )}
            <div className={styles.vpnCodeRow} style={hasVpnCode && !vpnActivationCode ? { display: 'none' } : undefined}>
              <input
                id="vpn-activation-input"
                type="password"
                className={styles.input}
                placeholder="Paste your activation code"
                value={vpnActivationCode}
                onChange={(e) => setVpnActivationCode(e.target.value)}
              />
              <a
                href="https://www.expressvpn.com/setup"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.vpnGetCode}
                title="Get your activation code"
              >
                Get code
              </a>
            </div>

            <div className={styles.vpnSteps}>
              <div className={styles.vpnStep}>
                <span className={styles.vpnStepNum}>1</span>
                <span>Visit <a href="https://www.expressvpn.com/setup" target="_blank" rel="noopener noreferrer">expressvpn.com/setup</a> and copy your activation code</span>
              </div>
              <div className={styles.vpnStep}>
                <span className={styles.vpnStepNum}>2</span>
                <span>Paste it above and save -- your code is encrypted before storage</span>
              </div>
            </div>

            <div className={styles.actions}>
              <button
                className={styles.saveButton}
                disabled={vpnCodeSaving || !vpnActivationCode}
                onClick={async () => {
                  setVpnCodeSaving(true);
                  setVpnCodeMessage('');
                  const res = await fetch('/api/admin/config', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      vpnActivationCode: vpnActivationCode,
                      vpnProvider: 'expressvpn',
                    }),
                  });
                  const data = await res.json();
                  if (data.ok) {
                    setConfig(data.data);
                    setHasVpnCode(true);
                    setVpnActivationCode('');
                    setVpnProvider('expressvpn');
                    setVpnCodeMessage('VPN configured');
                    // Refresh live status
                    fetch('/api/vpn/status').then((r) => r.json()).then((s) => { if (s.ok) setVpnLive(s.data); }).catch(() => {});
                  } else {
                    setVpnCodeMessage(data.error || 'Failed to save');
                  }
                  setVpnCodeSaving(false);
                }}
              >
                {vpnCodeSaving ? 'Saving...' : hasVpnCode ? 'Update Code' : 'Save Code'}
              </button>
              {vpnCodeMessage && <span className={styles.message}>{vpnCodeMessage}</span>}
            </div>
          </div>

          <div className={styles.vpnStealthInfo}>
            <h3 className={styles.vpnStealthTitle}>What happens when Flight Finder switches country</h3>
            <p className={styles.toggleHint}>
              Changing your IP is not enough. Websites detect mismatches between your IP and browser signals.
              Flight Finder aligns everything to match the target country:
            </p>
            <ul className={styles.vpnStealthList}>
              <li>IP address routed through VPN exit node</li>
              <li>Browser timezone set to match the country</li>
              <li>Accept-Language header and navigator.languages aligned</li>
              <li>Geolocation API returns the capital city coordinates</li>
              <li>Google Flights <code>gl=</code> country hint parameter set</li>
              <li>WebRTC leak prevention (real IP never exposed)</li>
              <li>DNS leak prevention (queries routed through VPN tunnel)</li>
              <li>Canvas and WebGL fingerprint noise (unique per session)</li>
              <li>AudioContext fingerprint randomization</li>
              <li>Screen dimensions matched to viewport</li>
              <li>Exit country verified via IP geolocation after connect</li>
            </ul>
          </div>
        </div>

        <div className={styles.section}>
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
              registrations, so hide this on self-hosted. */}
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

        {config.isSelfHosted && (
          <MultiUserSection
            enabled={config.multiUserMode}
            onEnabled={(backfillCount) => {
              setConfig({ ...config, multiUserMode: true });
              if (typeof window !== 'undefined') {
                window.localStorage.setItem('ft-backfill-count', String(backfillCount));
                window.localStorage.removeItem('ft-backfill-banner-dismissed');
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

interface MultiUserSectionProps {
  enabled: boolean;
  onEnabled: (backfillCount: number) => void;
}

function MultiUserSection({ enabled, onEnabled }: MultiUserSectionProps) {
  const [showForm, setShowForm] = useState(false);
  const [adminUsername, setAdminUsername] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (enabled) {
    return (
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Multi user mode</h2>
        <p className={styles.toggleHint}>
          Each household member has their own account, trackers, and preferences.
        </p>
        <Link href="/admin/users" className={styles.link}>
          Manage users
        </Link>
      </div>
    );
  }

  const handleEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    const res = await fetch('/api/admin/multi-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminUsername: adminUsername.trim(),
        adminPassword,
        displayName: displayName.trim() || null,
        avatar,
      }),
    });

    const data = await res.json();
    setSubmitting(false);

    if (!data.ok) {
      setError(data.error || 'Failed to enable multi user mode');
      return;
    }

    onEnabled(data.data.backfillCount);
    setShowForm(false);
    setAdminPassword('');
  };

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Multi user mode</h2>

      <div className={styles.toggleRow}>
        <button
          type="button"
          className={`${styles.toggle} ${showForm ? styles.toggleOn : ''}`}
          onClick={() => setShowForm((v) => !v)}
        >
          <span className={styles.toggleKnob} />
        </button>
        <div>
          <span className={styles.toggleLabel}>
            {showForm ? 'Enabling' : 'Disabled'}
          </span>
          <p className={styles.toggleHint}>
            Turn on to host multiple accounts on this instance (family, household).
            You stay admin; new users get their own trackers and preferences.
          </p>
        </div>
      </div>

      {showForm && (
        <form className={styles.fields} onSubmit={handleEnable}>
          <input
            type="text"
            className={styles.input}
            placeholder="Admin username (defaults to admin)"
            value={adminUsername}
            onChange={(e) => setAdminUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            type="text"
            className={styles.input}
            placeholder="Display name (optional)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            type="password"
            className={styles.input}
            placeholder="Admin password (optional — blank = no password)"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            autoComplete="new-password"
          />
          <p className={styles.toggleHint}>
            Leave blank for a Netflix-style household where everyone taps to sign in. Add
            a password only if this instance is reachable from the public internet.
          </p>
          <label className={styles.toggleHint}>Your avatar</label>
          <AvatarPicker value={avatar} onChange={setAvatar} name={displayName || adminUsername} />
          {error && <p className={styles.error}>{error}</p>}
          <button
            type="submit"
            className={styles.saveButton}
            disabled={submitting}
          >
            {submitting ? 'Enabling...' : 'Enable multi user mode'}
          </button>
        </form>
      )}
    </div>
  );
}
