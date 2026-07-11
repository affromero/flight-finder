'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { LOCALES, LOCALE_LABELS, LOCALE_COOKIE, isLocale } from '@/i18n/locales';
import styles from './page.module.css';
import { PROVIDER_METADATA, LOCAL_PROVIDERS } from '@/lib/scraper/provider-metadata';
import { AvatarPicker } from '@/components/AvatarPicker/AvatarPicker';

interface SetupStatus {
  setupComplete: boolean;
  needsSetup?: boolean;
  // The fields below are returned only while setup is incomplete (first-run).
  // Once the instance is configured, /api/setup/status returns just the two
  // booleans above, so treat these as optional and default them.
  isSelfHosted?: boolean;
  detectedProviders?: string[];
  currentProvider?: string | null;
  currentModel?: string | null;
}

export default function SetupPage() {
  const t = useTranslations('Setup');
  const locale = useLocale();
  const router = useRouter();
  const changeLocale = (value: string) => {
    if (!isLocale(value)) return;
    document.cookie = `${LOCALE_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
    // Soft refresh: re-renders server components with the new locale while
    // preserving wizard state entered so far.
    router.refresh();
  };
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState(0);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  // Provider API key entered during first-run setup (#149); stored encrypted.
  const [apiKey, setApiKey] = useState('');
  const [communitySharing, setCommunitySharing] = useState(false);
  const [enableMultiUser, setEnableMultiUser] = useState(false);
  const [multiUserUsername, setMultiUserUsername] = useState('');
  const [multiUserPassword, setMultiUserPassword] = useState('');
  const [multiUserDisplayName, setMultiUserDisplayName] = useState('');
  const [multiUserAvatar, setMultiUserAvatar] = useState<string | null>(null);
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
    setLocalModels([]); // clear stale data
    fetch(`/api/admin/local-models?provider=${p}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setLocalModels(d.data);
          // Only auto-select first model if user hasn't typed a custom one
          if (d.data.length > 0) {
            setModel((prev) => prev || d.data[0].id);
          }
        } else {
          setLocalModels([]);
          setLocalModelsError(d.error || t('fetchModelsFailed'));
        }
      })
      .catch(() => {
        setLocalModels([]);
        setLocalModelsError(t('couldNotConnect'));
      })
      .finally(() => setLocalModelsLoading(false));
  }, [t]);

  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((data: SetupStatus) => {
        if (data.setupComplete) {
          window.location.href = '/';
          return;
        }
        setStatus(data);
        if (data.isSelfHosted) {
          setStep(1);
        }
        const detected = data.detectedProviders ?? [];
        if (detected.length > 0) {
          const defaultProvider = detected[0]!;
          setProvider(defaultProvider);
          const providerConfig = PROVIDER_METADATA[defaultProvider];
          if (providerConfig?.models[0]) {
            setModel(providerConfig.models[0].id);
          }
          fetchLocalModels(defaultProvider);
        }
      })
      .catch(() => {
        setError(t('statusLoadFailed'));
      });
  }, [fetchLocalModels, t]);

  const handleSubmit = async () => {
    setError('');

    if (step === 0) {
      if (password.length < 8) {
        setError(t('passwordTooShort'));
        return;
      }
      if (password !== confirmPassword) {
        setError(t('passwordMismatch'));
        return;
      }
      setStep(1);
      return;
    }

    if (step === 1) {
      const effective = customModel.trim() || model;
      if (!provider || !effective) {
        const hint = LOCAL_PROVIDERS.has(provider) && localModelsError
          ? t('providerUnreachable', { provider: PROVIDER_METADATA[provider]?.displayName ?? provider })
          : t('selectProviderModel');
        setError(hint);
        return;
      }
      setStep(2);
      return;
    }

    if (step === 2 && status?.isSelfHosted) {
      // Self hosted gets a follow-on optional accounts step
      setStep(3);
      return;
    }

    if (step === 3 && status?.isSelfHosted) {
      // Validate the account fields here before moving to the reach step, so
      // bad credentials are caught before the final submit.
      if (enableMultiUser && multiUserPassword && multiUserPassword.length < 8) {
        setError(t('passwordTooShortOptional'));
        return;
      }
      setStep(4);
      return;
    }

    // Final step: complete setup (hosted: step 2, self hosted: step 4)
    const effectiveModel = customModel.trim() || model;
    setLoading(true);
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: password, provider, model: effectiveModel, communitySharing, customBaseUrl: customBaseUrl.trim() || null, publicBaseUrl: publicBaseUrl.trim() || null, apiKey: apiKey.trim() || null }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || t('setupFailed'));
      setLoading(false);
      return;
    }

    if (status?.isSelfHosted && enableMultiUser) {
      const username = multiUserUsername.trim();
      if (multiUserPassword && multiUserPassword.length < 8) {
        setError(t('passwordTooShortOptional'));
        setLoading(false);
        return;
      }
      const muRes = await fetch('/api/admin/multi-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminUsername: username,
          adminPassword: multiUserPassword,
          displayName: multiUserDisplayName.trim() || null,
          avatar: multiUserAvatar,
        }),
      });
      const muData = await muRes.json();
      if (!muRes.ok) {
        setError(muData.error || t('multiUserFailed'));
        setLoading(false);
        return;
      }
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('ft-backfill-count', String(muData.data.backfillCount));
        window.localStorage.removeItem('ft-backfill-banner-dismissed');
      }
    }

    window.location.href = '/';
  };

  if (!status) {
    return (
      <main className={styles.root}>
        <div className={styles.card}>
          {error ? <p className={styles.error}>{error}</p> : <p className={styles.loading}>{t('loading')}</p>}
        </div>
      </main>
    );
  }

  const CLI_PROVIDERS = new Set(['claude-code', 'codex']);
  const detectedProviders = status.detectedProviders ?? [];
  const hasCliProvider = detectedProviders.some((p) => CLI_PROVIDERS.has(p));

  const providerEntries = Object.entries(PROVIDER_METADATA);
  const isSelfHosted = status.isSelfHosted ?? false;
  const subtitles = [
    t('subtitlePassword'),
    t('subtitleProvider'),
    t('subtitleCommunity'),
    t('subtitleAccounts'),
    t('subtitleReach'),
  ];

  const isFinalStep = isSelfHosted ? step === 4 : step === 2;
  const submitLabel = loading
    ? t('settingUp')
    : isFinalStep
      ? (isSelfHosted && enableMultiUser ? t('completeSetupAccounts') : t('completeSetup'))
      : t('next');

  return (
    <main className={styles.root}>
      <div className={styles.card}>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.subtitle}>{subtitles[step]}</p>

        <div className={styles.steps}>
          {!isSelfHosted && (
            <>
              <span className={`${styles.step} ${step >= 0 ? styles.active : ''}`}>1. {t('stepPassword')}</span>
              <span className={styles.stepDivider}>/</span>
            </>
          )}
          <span className={`${styles.step} ${step >= 1 ? styles.active : ''}`}>{isSelfHosted ? '1' : '2'}. {t('stepProvider')}</span>
          <span className={styles.stepDivider}>/</span>
          <span className={`${styles.step} ${step >= 2 ? styles.active : ''}`}>{isSelfHosted ? '2' : '3'}. {t('stepCommunity')}</span>
          {isSelfHosted && (
            <>
              <span className={styles.stepDivider}>/</span>
              <span className={`${styles.step} ${step >= 3 ? styles.active : ''}`}>3. {t('stepAccounts')}</span>
              <span className={styles.stepDivider}>/</span>
              <span className={`${styles.step} ${step >= 4 ? styles.active : ''}`}>4. {t('stepReach')}</span>
            </>
          )}
        </div>

        {step === (isSelfHosted ? 1 : 0) && (
          <div className={styles.languageRow}>
            <label className={styles.languageLabel} htmlFor="setup-language">{t('language')}</label>
            <select
              id="setup-language"
              className={styles.languageSelect}
              defaultValue={locale}
              onChange={(e) => changeLocale(e.target.value)}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>{LOCALE_LABELS[l]}</option>
              ))}
            </select>
          </div>
        )}

        {step === 0 && (
          <div className={styles.fields}>
            <input
              type="password"
              className={styles.input}
              placeholder={t('adminPasswordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <input
              type="password"
              className={styles.input}
              placeholder={t('confirmPasswordPlaceholder')}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
        )}

        {step === 1 && (
          <div className={styles.fields}>
            {hasCliProvider && (
              <p className={styles.cliHint}>
                {t('cliHint')}
              </p>
            )}
            <div className={styles.providers}>
              {providerEntries.map(([key, config]) => {
                const detected = detectedProviders.includes(key);
                return (
                  <button
                    key={key}
                    className={`${styles.providerCard} ${provider === key ? styles.selected : ''} ${!detected ? styles.unavailable : ''}`}
                    onClick={() => {
                      setProvider(key);
                      setCustomModel('');
                      // Clear the key field when switching providers so a key
                      // typed for one is never submitted for another.
                      setApiKey('');
                      // Empty so the default is a placeholder, not a saved value.
                      // A persisted localhost would override the OLLAMA_HOST env
                      // (host.docker.internal) and break Ollama in Docker. #139.
                      setCustomBaseUrl('');
                      if (config.models[0]) setModel(config.models[0].id);
                      else setModel('');
                      fetchLocalModels(key);
                    }}
                  >
                    <span className={styles.providerName}>{config.displayName}</span>
                    <span className={styles.providerStatus}>
                      {detected
                        ? CLI_PROVIDERS.has(key)
                          ? t('statusSubscription')
                          : LOCAL_PROVIDERS.has(key)
                            ? t('statusLocal')
                            : t('statusReady')
                        : CLI_PROVIDERS.has(key)
                          ? t('statusNotInstalled')
                          : LOCAL_PROVIDERS.has(key)
                            ? t('statusLocal')
                            : t('statusNoKey')}
                    </span>
                  </button>
                );
              })}
            </div>

            {provider && PROVIDER_METADATA[provider] && (
              <>
                {PROVIDER_METADATA[provider]!.models.length > 0 && (
                  <select
                    className={styles.input}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {PROVIDER_METADATA[provider]!.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.costPer1kInput === 0 ? ` ${t('modelFree')}` : ` ${t('modelCost', { cost: m.costPer1kInput })}`}
                      </option>
                    ))}
                  </select>
                )}
                {PROVIDER_METADATA[provider]!.models.length === 0 && localModels.length > 0 && (
                  <select
                    className={styles.input}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {localModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}{m.size ? ` (${m.size})` : ''}
                      </option>
                    ))}
                  </select>
                )}
                {PROVIDER_METADATA[provider]!.models.length === 0 && localModelsLoading && (
                  <span className={styles.hint}>{t('fetchingModels')}</span>
                )}
                {PROVIDER_METADATA[provider]!.models.length === 0 && localModelsError && (
                  <span className={styles.hintError}>{localModelsError}</span>
                )}
                {PROVIDER_METADATA[provider]!.allowCustomModel && (
                  <input
                    type="text"
                    className={styles.input}
                    placeholder={localModels.length > 0
                      ? t('customModelPlaceholder')
                      : t('modelIdPlaceholder')}
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                  />
                )}
                {PROVIDER_METADATA[provider]!.envKey && (
                  <>
                    <input
                      type="password"
                      className={styles.input}
                      autoComplete="off"
                      placeholder={detectedProviders.includes(provider)
                        ? t('apiKeyOptionalPlaceholder', { envKey: PROVIDER_METADATA[provider]!.envKey })
                        : t('apiKeyPastePlaceholder', { provider: PROVIDER_METADATA[provider]!.displayName })}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                    <span className={styles.hint}>
                      {t('apiKeyHint', { envKey: PROVIDER_METADATA[provider]!.envKey })}
                    </span>
                  </>
                )}
                {PROVIDER_METADATA[provider]!.allowCustomBaseUrl && (
                  <input
                    type="url"
                    className={styles.input}
                    placeholder={PROVIDER_METADATA[provider]!.defaultBaseUrl || 'https://...'}
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                  />
                )}
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className={styles.fields}>
            <div className={styles.communityCard}>
              <h3 className={styles.communityTitle}>
                {t('communityTitle')}
              </h3>
              <p className={styles.communityText}>
                {t('communityText')}
              </p>
              <button
                className={`${styles.communityToggle} ${communitySharing ? styles.communityActive : ''}`}
                onClick={() => setCommunitySharing(!communitySharing)}
              >
                {communitySharing ? t('sharingEnabled') : t('notSharing')}
              </button>
            </div>
            <p className={styles.communityHint}>
              {t('communityHint')}
            </p>
          </div>
        )}

        {step === 3 && isSelfHosted && (
          <div className={styles.fields}>
            <div className={styles.communityCard}>
              <h3 className={styles.communityTitle}>{t('whoUsesThis')}</h3>
              <div className={styles.choiceRow}>
                <button
                  type="button"
                  className={`${styles.choice} ${!enableMultiUser ? styles.choiceActive : ''}`}
                  onClick={() => setEnableMultiUser(false)}
                >
                  {t('justMe')}
                </button>
                <button
                  type="button"
                  className={`${styles.choice} ${enableMultiUser ? styles.choiceActive : ''}`}
                  onClick={() => setEnableMultiUser(true)}
                >
                  {t('household')}
                </button>
              </div>
              <p className={styles.communityText}>
                {enableMultiUser ? t('householdText') : t('justMeText')}
              </p>
            </div>
            {enableMultiUser && (
              <>
                <input
                  type="text"
                  className={styles.input}
                  placeholder={t('adminUsernamePlaceholder')}
                  value={multiUserUsername}
                  onChange={(e) => setMultiUserUsername(e.target.value)}
                  autoComplete="username"
                />
                <input
                  type="text"
                  className={styles.input}
                  placeholder={t('displayNamePlaceholder')}
                  value={multiUserDisplayName}
                  onChange={(e) => setMultiUserDisplayName(e.target.value)}
                />
                <input
                  type="password"
                  className={styles.input}
                  placeholder={t('adminPasswordOptionalPlaceholder')}
                  value={multiUserPassword}
                  onChange={(e) => setMultiUserPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <p className={styles.communityHint}>
                  {t('passwordBlankHint')}
                </p>
                <label className={styles.avatarLabel}>{t('profileAvatar')}</label>
                <AvatarPicker
                  value={multiUserAvatar}
                  onChange={setMultiUserAvatar}
                  name={multiUserDisplayName || multiUserUsername}
                />
              </>
            )}
          </div>
        )}

        {step === 4 && isSelfHosted && (
          <div className={styles.fields}>
            <div className={styles.communityCard}>
              <h3 className={styles.communityTitle}>{t('phoneTitle')}</h3>
              <p className={styles.communityText}>
                {t.rich('phoneText', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
            </div>
            <label className={styles.avatarLabel} htmlFor="publicBaseUrl">{t('haveUrl')}</label>
            <input
              id="publicBaseUrl"
              type="url"
              className={styles.input}
              placeholder="https://flights.yourdomain.org"
              value={publicBaseUrl}
              onChange={(e) => setPublicBaseUrl(e.target.value)}
            />
            <p className={styles.communityHint}>
              {t('publicUrlHint')}
            </p>
          </div>
        )}

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          {step > (isSelfHosted ? 1 : 0) && (
            <button
              className={styles.backButton}
              onClick={() => setStep(step - 1)}
            >
              {t('back')}
            </button>
          )}
          <button
            className={styles.button}
            onClick={handleSubmit}
            disabled={loading}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </main>
  );
}
