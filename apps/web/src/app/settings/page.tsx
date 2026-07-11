'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LOCALES, LOCALE_LABELS, LOCALE_COOKIE, DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/locales';
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
  const t = useTranslations('Settings');
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
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const router = useRouter();

  useEffect(() => {
    const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
    const value = match?.[1];
    if (isLocale(value)) setLocaleState(value);
  }, []);

  const changeLocale = (value: string) => {
    if (!isLocale(value)) return;
    setLocaleState(value);
    document.cookie = `${LOCALE_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };

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
          setLocalModelsError(d.error || t('extraction.fetchModelsFailed'));
        }
      })
      .catch(() => {
        setLocalModels([]);
        setLocalModelsError(t('extraction.couldNotConnect'));
      })
      .finally(() => setLocalModelsLoading(false));
  }, [t]);

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
      setMessage(t('extraction.enterModelId'));
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
      setMessage(t('extraction.saved'));
      if (LOCAL_PROVIDERS.has(provider)) {
        fetchLocalModels(provider);
      }
    } else {
      setMessage(data.error || t('extraction.saveFailed'));
    }
    setSaving(false);
  };

  if (!config) return null;

  return (
    <div className={styles.root}>
      <div className={styles.content}>
        <div className={styles.header}>
          <Link href="/" className={styles.backLink} title={t('backToHome')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h1 className={styles.title}>{t('title')}</h1>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('appearance.title')}</h2>
          <p className={styles.toggleHint}>
            {t('appearance.hint')}
          </p>

          <ThemePicker
            value={theme}
            onSelect={async (id) => {
              setTheme(id);
              setThemeMessage(t('appearance.saving'));
              try {
                const res = await fetch('/api/admin/config', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ theme: id }),
                });
                const data = await res.json();
                setThemeMessage(data.ok ? t('appearance.saved') : (data.error || t('appearance.saveThemeFailed')));
                if (data.ok) setConfig(data.data);
              } catch {
                setThemeMessage(t('appearance.saveThemeFailed'));
              }
            }}
          />

          {themeMessage && <span className={styles.message}>{themeMessage}</span>}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="language-select">{t('appearance.language')}</label>
            <select
              id="language-select"
              className={styles.select}
              value={locale}
              onChange={(e) => changeLocale(e.target.value)}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>{LOCALE_LABELS[l]}</option>
              ))}
            </select>
          </div>
        </div>

        {config.isSelfHosted && (
          <div className={styles.section} id="reach">
            <h2 className={styles.sectionTitle}>{t('reach.title')}</h2>
            <p className={styles.toggleHint}>
              {t('reach.hint')}
            </p>
            <ReachGuide />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="publicBaseUrl">{t('reach.publicUrl')}</label>
              <input
                id="publicBaseUrl"
                type="url"
                className={styles.input}
                placeholder="https://flights.yourdomain.org"
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
              />
              <span className={styles.toggleHint}>
                {t('reach.publicUrlHint')}
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
                    setReachMessage(data.ok ? t('reach.saved') : (data.error || t('reach.saveFailed')));
                  } catch {
                    setReachMessage(t('reach.saveFailed'));
                  } finally {
                    setReachSaving(false);
                  }
                }}
              >
                {reachSaving ? t('reach.saving') : t('reach.saveUrl')}
              </button>
              <Link href="/connect" className={styles.secondaryLink}>{t('reach.phoneSetup')}</Link>
              {reachMessage && <span className={styles.message}>{reachMessage}</span>}
            </div>
          </div>
        )}

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('extraction.title')}</h2>

          <div className={styles.field}>
            <label className={styles.label}>{t('extraction.provider')}</label>
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
                          ? isCli ? t('extraction.statusSubscription') : isLocal ? t('extraction.statusLocal') : t('extraction.statusReady')
                          : isCli ? t('extraction.statusSetUp') : isLocal ? t('extraction.statusLocal') : t('extraction.statusAddKey')}
                      </span>
                    </button>
                    {configuringProvider === key && !detected && (
                      <div className={styles.providerConfigure}>
                        {isCli && key === 'claude-code' ? (
                          <>
                            <p className={styles.providerConfigHint}>
                              {t.rich('extraction.claudeCodeHint', { code: (chunks) => <code>{chunks}</code> })}
                            </p>
                            <div className={styles.providerConfigRow}>
                              <input
                                type="password"
                                className={styles.input}
                                placeholder={t('extraction.pasteSetupToken')}
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
                                  setMessage(t('extraction.addTokenEnvHint'));
                                  setConfiguringProvider(null);
                                }}
                              >
                                {t('extraction.save')}
                              </button>
                            </div>
                          </>
                        ) : isCli && key === 'codex' ? (
                          <>
                            <p className={styles.providerConfigHint}>
                              {t.rich('extraction.codexHint', { code: (chunks) => <code>{chunks}</code> })}
                            </p>
                          </>
                        ) : (
                          <>
                            <p className={styles.providerConfigHint}>
                              {t('extraction.pasteApiKey', { name: p.displayName })}
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
                                  setMessage(t('extraction.addKeyEnvHint', { envKey: p.envKey ?? '', keyPrefix: providerKeyInput.slice(0, 8) }));
                                  setProviderKeySaving(false);
                                  setConfiguringProvider(null);
                                  setProviderKeyInput('');
                                }}
                              >
                                {t('extraction.save')}
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
            <label className={styles.label}>{t('extraction.model')}</label>
            {models.length > 0 && (
              <select
                className={styles.select}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.costPer1kInput === 0 ? t('extraction.freeCli') : t('extraction.costPer1kIn', { cost: m.costPer1kInput })})
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
              <span className={styles.modelHint}>{t('extraction.fetchingModels')}</span>
            )}
            {models.length === 0 && localModelsError && (
              <span className={styles.modelHintError}>{localModelsError}</span>
            )}
            {providerConfig?.allowCustomModel && (
              <input
                type="text"
                className={styles.input}
                placeholder={models.length === 0 && localModels.length === 0
                  ? t('extraction.modelIdPlaceholder')
                  : t('extraction.customModelPlaceholder')}
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
              />
            )}
          </div>

          {providerConfig?.allowCustomBaseUrl && (
            <div className={styles.field}>
              <label className={styles.label}>{t('extraction.apiBaseUrl')}</label>
              <input
                type="url"
                className={styles.input}
                placeholder={providerConfig.defaultBaseUrl || 'https://...'}
                value={customBaseUrl}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
              />
              <span className={styles.toggleHint}>
                {providerConfig.defaultBaseUrl
                  ? t('extraction.defaultBaseUrl', { url: providerConfig.defaultBaseUrl })
                  : t('extraction.leaveEmptyForDefault')}
              </span>
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>{t('extraction.scrapeInterval')}</label>
            <select
              className={styles.select}
              value={scrapeInterval}
              onChange={(e) => setScrapeInterval(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
                <option key={h} value={h}>{t('extraction.everyHours', { hours: h })}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>{t('extraction.defaultCurrency')}</label>
            <select
              className={styles.select}
              value={['', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'MXN', 'BRL', 'KRW', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'NZD', 'THB', 'COP', 'ARS'].includes(defaultCurrency) ? defaultCurrency : '_custom'}
              onChange={(e) => setDefaultCurrency(e.target.value === '_custom' ? '' : e.target.value)}
            >
              <option value="">{t('extraction.autoDetect')}</option>
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
              <option value="_custom">{t('extraction.otherCurrency')}</option>
            </select>
            {!['', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'MXN', 'BRL', 'KRW', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'NZD', 'THB', 'COP', 'ARS'].includes(defaultCurrency) && (
              <input
                type="text"
                className={styles.input}
                placeholder={t('extraction.currencyCodePlaceholder')}
                value={defaultCurrency}
                onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())}
                maxLength={3}
              />
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label}>{t('extraction.defaultSearchMethod')}</label>
            <select
              className={styles.select}
              value={defaultSearchMethod}
              onChange={(e) => setDefaultSearchMethod(e.target.value as 'ai' | 'manual')}
            >
              <option value="ai">{t('extraction.searchMethodAi')}</option>
              <option value="manual">{t('extraction.searchMethodManual')}</option>
            </select>
            <span className={styles.toggleHint}>
              {t('extraction.searchMethodHint')}
            </span>
          </div>

          <div className={styles.actions}>
            <button className={styles.saveButton} onClick={handleSave} disabled={saving}>
              {saving ? t('extraction.saving') : t('extraction.save')}
            </button>
            {message && <span className={styles.message}>{message}</span>}
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('vpn.title')}</h2>
          <p className={styles.toggleHint}>
            {t('vpn.hint')}
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
                  {vpnLive?.ready ? t('vpn.statusConnected') : hasVpnCode ? (vpnLive?.sidecarRunning === false ? t('vpn.statusSidecarOffline') : t('vpn.statusCodeSaved')) : t('vpn.statusNotSetUp')}
                </span>
              </div>
              <span className={styles.vpnCardDesc}>{t('vpn.expressVpnDesc')}</span>
            </button>

            <div className={styles.vpnCardDisabled}>
              <div className={styles.vpnCardHeader}>
                <span className={styles.vpnCardName}>NordVPN</span>
                <span className={styles.vpnCardStatusOff}>{t('vpn.comingSoon')}</span>
              </div>
              <span className={styles.vpnCardDesc}>{t('vpn.nordVpnDesc')}</span>
            </div>

            <div className={styles.vpnCardDisabled}>
              <div className={styles.vpnCardHeader}>
                <span className={styles.vpnCardName}>Mullvad</span>
                <span className={styles.vpnCardStatusOff}>{t('vpn.comingSoon')}</span>
              </div>
              <span className={styles.vpnCardDesc}>{t('vpn.mullvadDesc')}</span>
            </div>

            <div className={styles.vpnCardDisabled}>
              <div className={styles.vpnCardHeader}>
                <span className={styles.vpnCardName}>{t('vpn.customProxy')}</span>
                <span className={styles.vpnCardStatusOff}>{t('vpn.comingSoon')}</span>
              </div>
              <span className={styles.vpnCardDesc}>{t('vpn.customProxyDesc')}</span>
            </div>
          </div>

          <div className={styles.vpnActivation}>
            <label className={styles.label}>
              {t('vpn.activationCode')}
              {hasVpnCode && <span className={styles.vpnCodeSaved}> {t('vpn.codeSavedSuffix')}</span>}
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
                  {t('vpn.change')}
                </button>
              </div>
            )}
            <div className={styles.vpnCodeRow} style={hasVpnCode && !vpnActivationCode ? { display: 'none' } : undefined}>
              <input
                id="vpn-activation-input"
                type="password"
                className={styles.input}
                placeholder={t('vpn.activationCodePlaceholder')}
                value={vpnActivationCode}
                onChange={(e) => setVpnActivationCode(e.target.value)}
              />
              <a
                href="https://www.expressvpn.com/setup"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.vpnGetCode}
                title={t('vpn.getCodeTitle')}
              >
                {t('vpn.getCode')}
              </a>
            </div>

            <div className={styles.vpnSteps}>
              <div className={styles.vpnStep}>
                <span className={styles.vpnStepNum}>1</span>
                <span>{t.rich('vpn.step1', { link: (chunks) => <a href="https://www.expressvpn.com/setup" target="_blank" rel="noopener noreferrer">{chunks}</a> })}</span>
              </div>
              <div className={styles.vpnStep}>
                <span className={styles.vpnStepNum}>2</span>
                <span>{t('vpn.step2')}</span>
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
                    setVpnCodeMessage(t('vpn.configured'));
                    // Refresh live status
                    fetch('/api/vpn/status').then((r) => r.json()).then((s) => { if (s.ok) setVpnLive(s.data); }).catch(() => {});
                  } else {
                    setVpnCodeMessage(data.error || t('vpn.saveFailed'));
                  }
                  setVpnCodeSaving(false);
                }}
              >
                {vpnCodeSaving ? t('vpn.saving') : hasVpnCode ? t('vpn.updateCode') : t('vpn.saveCode')}
              </button>
              {vpnCodeMessage && <span className={styles.message}>{vpnCodeMessage}</span>}
            </div>
          </div>

          <div className={styles.vpnStealthInfo}>
            <h3 className={styles.vpnStealthTitle}>{t('vpn.stealthTitle')}</h3>
            <p className={styles.toggleHint}>
              {t('vpn.stealthHint')}
            </p>
            <ul className={styles.vpnStealthList}>
              <li>{t('vpn.stealthIp')}</li>
              <li>{t('vpn.stealthTimezone')}</li>
              <li>{t('vpn.stealthAcceptLanguage')}</li>
              <li>{t('vpn.stealthGeolocation')}</li>
              <li>{t.rich('vpn.stealthGlParam', { code: (chunks) => <code>{chunks}</code> })}</li>
              <li>{t('vpn.stealthWebrtc')}</li>
              <li>{t('vpn.stealthDns')}</li>
              <li>{t('vpn.stealthCanvas')}</li>
              <li>{t('vpn.stealthAudio')}</li>
              <li>{t('vpn.stealthScreen')}</li>
              <li>{t('vpn.stealthExitCountry')}</li>
            </ul>
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('community.title')}</h2>

          <p className={styles.toggleHint}>
            {t('community.hint')}
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
                {config.communitySharing ? t('community.sharingEnabled') : t('community.sharingDisabled')}
              </span>
              <p className={styles.toggleHint}>
                {t('community.contributeHint')}
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
                  {config.communityRegistrationOpen ? t('community.hubAccepting') : t('community.hubClosed')}
                </span>
                <p className={styles.toggleHint}>
                  {t('community.hubHint')}
                </p>
              </div>
            </div>
          )}

          {config.communityApiKey && (
            <div className={styles.field}>
              <label className={styles.label}>{t('community.apiKey')}</label>
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
  const t = useTranslations('Settings');
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
        <h2 className={styles.sectionTitle}>{t('multiUser.title')}</h2>
        <p className={styles.toggleHint}>
          {t('multiUser.enabledHint')}
        </p>
        <Link href="/admin/users" className={styles.link}>
          {t('multiUser.manageUsers')}
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
      setError(data.error || t('multiUser.enableFailed'));
      return;
    }

    onEnabled(data.data.backfillCount);
    setShowForm(false);
    setAdminPassword('');
  };

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>{t('multiUser.title')}</h2>

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
            {showForm ? t('multiUser.enabling') : t('multiUser.disabled')}
          </span>
          <p className={styles.toggleHint}>
            {t('multiUser.toggleHint')}
          </p>
        </div>
      </div>

      {showForm && (
        <form className={styles.fields} onSubmit={handleEnable}>
          <input
            type="text"
            className={styles.input}
            placeholder={t('multiUser.adminUsernamePlaceholder')}
            value={adminUsername}
            onChange={(e) => setAdminUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            type="text"
            className={styles.input}
            placeholder={t('multiUser.displayNamePlaceholder')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            type="password"
            className={styles.input}
            placeholder={t('multiUser.adminPasswordPlaceholder')}
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            autoComplete="new-password"
          />
          <p className={styles.toggleHint}>
            {t('multiUser.passwordHint')}
          </p>
          <label className={styles.toggleHint}>{t('multiUser.yourAvatar')}</label>
          <AvatarPicker value={avatar} onChange={setAvatar} name={displayName || adminUsername} />
          {error && <p className={styles.error}>{error}</p>}
          <button
            type="submit"
            className={styles.saveButton}
            disabled={submitting}
          >
            {submitting ? t('multiUser.enablingButton') : t('multiUser.enableButton')}
          </button>
        </form>
      )}
    </div>
  );
}
