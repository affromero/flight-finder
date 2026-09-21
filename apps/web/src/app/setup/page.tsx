'use client';

import { useState, useEffect, useCallback } from 'react';
import { ProviderCredentialFields } from '@/components/ProviderCredentialFields/ProviderCredentialFields';
import { InstanceVerification } from '@/components/ProviderCredentialFields/InstanceVerification';
import type { ProviderFieldsPatch, ProviderFieldStatus } from 'thesidedoor/react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { LOCALES, LOCALE_LABELS, LOCALE_COOKIE, isLocale } from '@/i18n/locales';
import styles from './page.module.css';
import { PROVIDER_METADATA, LOCAL_PROVIDERS } from '@/lib/scraper/provider-metadata';
import { CliModelPicker } from '@/components/CliModelPicker/CliModelPicker';
import { orderedProviders, type ReasoningSelection } from '@/lib/scraper/cli-model-types';

interface SetupStatus {
  providerCredentials?: Array<{ provider: string; error?: string; fields: ProviderFieldStatus[] }>;
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
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [reasoning, setReasoning] = useState<ReasoningSelection>(null);
  const [credentialFields, setCredentialFields] = useState<ProviderFieldsPatch>({});
  const [resetCredentials, setResetCredentials] = useState(false);
  const [verifying, setVerifying] = useState(false);
  // Provider API key entered during first-run setup (#149); stored encrypted.
  const [communitySharing, setCommunitySharing] = useState(false);
  const [enableMultiUser, setEnableMultiUser] = useState(false);
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
      setStep(4);
      return;
    }

    // Final step: complete setup (hosted: step 2, self hosted: step 4)
    const effectiveModel = customModel.trim() || model;
    setLoading(true);
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model: effectiveModel, reasoningEffort: reasoning, communitySharing, publicBaseUrl: publicBaseUrl.trim() || null, credentials: credentialFields, resetCredentials }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || t('setupFailed'));
      setLoading(false);
      return;
    }

    if (status?.isSelfHosted && enableMultiUser) {
      const muRes = await fetch('/api/admin/multi-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
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

  const providerEntries = orderedProviders(detectedProviders);
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
          <span className={`${styles.step} ${step >= 1 ? styles.active : ''}`}>1. {t('stepProvider')}</span>
          <span className={styles.stepDivider}>/</span>
          <span className={`${styles.step} ${step >= 2 ? styles.active : ''}`}>2. {t('stepCommunity')}</span>
          {isSelfHosted && (
            <>
              <span className={styles.stepDivider}>/</span>
              <span className={`${styles.step} ${step >= 3 ? styles.active : ''}`}>3. {t('stepAccounts')}</span>
              <span className={styles.stepDivider}>/</span>
              <span className={`${styles.step} ${step >= 4 ? styles.active : ''}`}>4. {t('stepReach')}</span>
            </>
          )}
        </div>

        {step === 1 && (
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
                      setReasoning(null);
                      setCustomModel('');
                      // Clear the key field when switching providers so a key
                      // typed for one is never submitted for another.
                      setCredentialFields({});
                      setResetCredentials(false);
                      // Empty so the default is a placeholder, not a saved value.
                      // A persisted localhost would override the OLLAMA_HOST env
                      // (host.docker.internal) and break Ollama in Docker. #139.
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
                {CLI_PROVIDERS.has(provider) && <CliModelPicker key={provider} setup provider={provider} model={customModel || model} reasoning={reasoning}
                  onModelChange={value => { setModel(value); setCustomModel(''); }} onReasoningChange={setReasoning} />}
                {!CLI_PROVIDERS.has(provider) && PROVIDER_METADATA[provider]!.models.length > 0 && (
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
                <ProviderCredentialFields provider={provider} fields={status?.providerCredentials?.find(item => item.provider === provider)?.fields} error={Boolean(status?.providerCredentials?.find(item => item.provider === provider)?.error)} patch={credentialFields} onChange={setCredentialFields} disabled={loading} reset={resetCredentials} onResetChange={setResetCredentials} />
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

        <InstanceVerification disabled={loading} onBusyChange={setVerifying} />
        <div className={styles.actions}>
          {step > 1 && (
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
            disabled={loading || verifying}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </main>
  );
}
