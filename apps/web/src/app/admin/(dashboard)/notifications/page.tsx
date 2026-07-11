'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import styles from './page.module.css';

type ChannelType = 'telegram' | 'email' | 'ntfy' | 'webhook';

interface FieldDef {
  key: string;
  type: 'text' | 'password' | 'number' | 'checkbox';
  placeholder?: string;
  optional?: boolean;
  secret?: boolean;
}

const FIELD_DEFS: Record<ChannelType, FieldDef[]> = {
  telegram: [
    { key: 'botToken', type: 'password', secret: true },
    { key: 'chatId', type: 'text' },
  ],
  email: [
    { key: 'host', type: 'text', placeholder: 'smtp.gmail.com' },
    { key: 'port', type: 'number', placeholder: '587' },
    { key: 'secure', type: 'checkbox' },
    { key: 'user', type: 'text', optional: true },
    { key: 'pass', type: 'password', optional: true, secret: true },
    { key: 'from', type: 'text', placeholder: 'alerts@you.com' },
    { key: 'to', type: 'text', placeholder: 'you@you.com' },
  ],
  ntfy: [
    { key: 'server', type: 'text', placeholder: 'https://ntfy.sh', optional: true },
    { key: 'topic', type: 'text', placeholder: 'my-flight-alerts' },
    { key: 'token', type: 'password', optional: true, secret: true },
  ],
  webhook: [
    { key: 'url', type: 'text', placeholder: 'https://...' },
    { key: 'secret', type: 'password', optional: true, secret: true },
  ],
};

const CHANNEL_TYPES: ChannelType[] = ['telegram', 'email', 'ntfy', 'webhook'];

type FormValues = Record<string, string | boolean>;

interface Channel {
  id: string;
  type: ChannelType;
  label: string | null;
  enabled: boolean;
  createdAt: string;
  config: Record<string, unknown>;
}

function initialValues(type: ChannelType, config?: Record<string, unknown>): FormValues {
  const values: FormValues = {};
  for (const f of FIELD_DEFS[type]) {
    if (f.secret) {
      values[f.key] = ''; // never prefilled; redacted on the server
    } else if (f.type === 'checkbox') {
      values[f.key] = config ? Boolean(config[f.key]) : false;
    } else {
      values[f.key] = config && config[f.key] != null ? String(config[f.key]) : '';
    }
  }
  return values;
}

function buildConfig(type: ChannelType, values: FormValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const f of FIELD_DEFS[type]) {
    const v = values[f.key];
    if (f.type === 'checkbox') {
      config[f.key] = Boolean(v);
    } else if (typeof v === 'string' && v.trim() !== '') {
      config[f.key] = f.type === 'number' ? Number(v) : v.trim();
    }
  }
  return config;
}

export default function NotificationsPage() {
  const t = useTranslations('AdminNotifications');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  // Global notification settings (stored on ExtractionConfig).
  const [minDropAbs, setMinDropAbs] = useState(5);
  const [minDropPct, setMinDropPct] = useState(0);
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [settingsMsg, setSettingsMsg] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  // Add / edit channel form.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState<ChannelType>('telegram');
  const [formLabel, setFormLabel] = useState('');
  const [formValues, setFormValues] = useState<FormValues>(initialValues('telegram'));
  const [formMsg, setFormMsg] = useState('');
  const [savingForm, setSavingForm] = useState(false);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  // Which optional secrets the channel being edited already has set, and which
  // of those the user has marked to remove on save.
  const [secretsSet, setSecretsSet] = useState<Record<string, boolean>>({});
  const [clearSecrets, setClearSecrets] = useState<Set<string>>(new Set());

  const loadChannels = useCallback(async () => {
    const res = await fetch('/api/admin/notifications');
    const data = await res.json();
    if (data.ok) setChannels(data.data.channels);
  }, []);

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/notifications').then((r) => r.json()),
      fetch('/api/admin/config').then((r) => r.json()),
    ]).then(([chanData, confData]) => {
      if (chanData.ok) setChannels(chanData.data.channels);
      if (confData.ok) {
        setMinDropAbs(confData.data.notifyMinDropAbs ?? 5);
        setMinDropPct((confData.data.notifyMinDropPct ?? 0) * 100);
        setPublicBaseUrl(confData.data.publicBaseUrl ?? '');
      }
      setLoading(false);
    });
  }, []);

  const resetForm = (type: ChannelType = 'telegram') => {
    setEditingId(null);
    setFormType(type);
    setFormLabel('');
    setFormValues(initialValues(type));
    setSecretsSet({});
    setClearSecrets(new Set());
    setFormMsg('');
  };

  const startEdit = (channel: Channel) => {
    setEditingId(channel.id);
    setFormType(channel.type);
    setFormLabel(channel.label ?? '');
    setFormValues(initialValues(channel.type, channel.config));
    // The redacted config carries `<field>Set` booleans for each secret.
    const flags: Record<string, boolean> = {};
    for (const f of FIELD_DEFS[channel.type]) {
      if (f.secret) flags[f.key] = Boolean(channel.config[`${f.key}Set`]);
    }
    setSecretsSet(flags);
    setClearSecrets(new Set());
    setFormMsg('');
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setSettingsMsg('');
    const res = await fetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notifyMinDropAbs: minDropAbs,
        notifyMinDropPct: minDropPct / 100,
        publicBaseUrl: publicBaseUrl.trim() || null,
      }),
    });
    const data = await res.json();
    setSettingsMsg(data.ok ? t('thresholds.saved') : data.error || t('failedToSave'));
    setSavingSettings(false);
  };

  const handleSubmitForm = async () => {
    setSavingForm(true);
    setFormMsg('');
    const config = buildConfig(formType, formValues);
    // Explicit null tells the API to clear a stored optional secret.
    for (const key of clearSecrets) config[key] = null;
    const url = editingId ? `/api/admin/notifications/${editingId}` : '/api/admin/notifications';
    const method = editingId ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: formType, label: formLabel.trim() || null, config }),
    });
    const data = await res.json();
    if (data.ok) {
      resetForm();
      await loadChannels();
    } else {
      setFormMsg(data.error || t('form.failedToSaveChannel'));
    }
    setSavingForm(false);
  };

  const toggleEnabled = async (channel: Channel) => {
    const res = await fetch(`/api/admin/notifications/${channel.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !channel.enabled }),
    });
    if ((await res.json()).ok) await loadChannels();
  };

  const sendTest = async (channel: Channel) => {
    setRowMsg((m) => ({ ...m, [channel.id]: t('channels.sending') }));
    const res = await fetch(`/api/admin/notifications/${channel.id}/test`, { method: 'POST' });
    const data = await res.json();
    setRowMsg((m) => ({ ...m, [channel.id]: data.ok ? t('channels.testSent') : data.error || t('channels.failed') }));
  };

  const deleteChannel = async (channel: Channel) => {
    if (!confirm(t('channels.deleteConfirm', { type: t(`types.${channel.type}`) }))) return;
    const res = await fetch(`/api/admin/notifications/${channel.id}`, { method: 'DELETE' });
    if ((await res.json()).ok) {
      if (editingId === channel.id) resetForm();
      await loadChannels();
    }
  };

  if (loading) {
    return <div className={styles.root}><p className={styles.loading}>{t('loading')}</p></div>;
  }

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.intro}>
        {t('intro')}
      </p>

      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>{t('thresholds.title')}</h2>
        <div className={styles.field}>
          <label className={styles.label}>{t('thresholds.minDrop')}</label>
          <input
            type="number"
            className={styles.input}
            min={0}
            step={1}
            value={minDropAbs}
            onChange={(e) => setMinDropAbs(Number(e.target.value))}
          />
          <span className={styles.hint}>{t('thresholds.minDropHint')}</span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('thresholds.minPct')}</label>
          <input
            type="number"
            className={styles.input}
            min={0}
            max={100}
            step={1}
            value={minDropPct}
            onChange={(e) => setMinDropPct(Number(e.target.value))}
          />
          <span className={styles.hint}>{t('thresholds.minPctHint')}</span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('thresholds.publicUrl')}</label>
          <input
            type="url"
            className={styles.input}
            placeholder="https://flights.yourdomain.com"
            value={publicBaseUrl}
            onChange={(e) => setPublicBaseUrl(e.target.value)}
          />
          <span className={styles.hint}>{t('thresholds.publicUrlHint')}</span>
        </div>
        <div className={styles.actions}>
          <button className={styles.primary} onClick={handleSaveSettings} disabled={savingSettings}>
            {savingSettings ? t('thresholds.saving') : t('thresholds.save')}
          </button>
          {settingsMsg && <span className={styles.msg}>{settingsMsg}</span>}
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>{t('channels.title')}</h2>
        {channels.length === 0 && <p className={styles.empty}>{t('channels.empty')}</p>}
        <ul className={styles.channelList}>
          {channels.map((c) => (
            <li key={c.id} className={styles.channelRow}>
              <div className={styles.channelInfo}>
                <span className={styles.channelType}>{t(`types.${c.type}`)}</span>
                {c.label && <span className={styles.channelLabel}>{c.label}</span>}
                <span className={c.enabled ? styles.badgeOn : styles.badgeOff}>
                  {c.enabled ? t('channels.enabled') : t('channels.disabled')}
                </span>
                {rowMsg[c.id] && <span className={styles.rowMsg}>{rowMsg[c.id]}</span>}
              </div>
              <div className={styles.channelActions}>
                <button className={styles.ghost} onClick={() => sendTest(c)}>{t('channels.sendTest')}</button>
                <button className={styles.ghost} onClick={() => toggleEnabled(c)}>
                  {c.enabled ? t('channels.disable') : t('channels.enable')}
                </button>
                <button className={styles.ghost} onClick={() => startEdit(c)}>{t('channels.edit')}</button>
                <button className={styles.danger} onClick={() => deleteChannel(c)}>{t('channels.delete')}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>{editingId ? t('form.editTitle') : t('form.addTitle')}</h2>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.type')}</label>
          <select
            className={styles.select}
            value={formType}
            disabled={!!editingId}
            onChange={(e) => {
              const next = e.target.value as ChannelType;
              setFormType(next);
              setFormValues(initialValues(next));
            }}
          >
            {CHANNEL_TYPES.map((ct) => (
              <option key={ct} value={ct}>{t(`types.${ct}`)}</option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.label')}</label>
          <input
            type="text"
            className={styles.input}
            placeholder={t('form.labelPlaceholder')}
            value={formLabel}
            onChange={(e) => setFormLabel(e.target.value)}
          />
        </div>
        {FIELD_DEFS[formType].map((f) => (
          <div className={styles.field} key={f.key}>
            <label className={styles.label}>
              {t(`fields.${f.key}`)}
              {f.optional && <span className={styles.optional}>{t('form.optionalSuffix')}</span>}
            </label>
            {f.type === 'checkbox' ? (
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={Boolean(formValues[f.key])}
                onChange={(e) => setFormValues((v) => ({ ...v, [f.key]: e.target.checked }))}
              />
            ) : (
              <>
                <input
                  type={f.type === 'number' ? 'number' : f.type}
                  className={styles.input}
                  placeholder={
                    clearSecrets.has(f.key)
                      ? t('form.removedOnSave')
                      : f.secret && editingId && secretsSet[f.key]
                        ? t('form.keepCurrent')
                        : f.placeholder ?? ''
                  }
                  value={String(formValues[f.key] ?? '')}
                  disabled={clearSecrets.has(f.key)}
                  onChange={(e) => setFormValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
                {f.secret && f.optional && editingId && secretsSet[f.key] && (
                  <label className={styles.clearToggle}>
                    <input
                      type="checkbox"
                      checked={clearSecrets.has(f.key)}
                      onChange={(e) =>
                        setClearSecrets((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(f.key);
                          else next.delete(f.key);
                          return next;
                        })
                      }
                    />
                    {t('form.removeSaved')}
                  </label>
                )}
              </>
            )}
          </div>
        ))}
        <div className={styles.actions}>
          <button className={styles.primary} onClick={handleSubmitForm} disabled={savingForm}>
            {savingForm ? t('form.saving') : editingId ? t('form.saveChanges') : t('form.addChannel')}
          </button>
          {editingId && (
            <button className={styles.ghost} onClick={() => resetForm()}>{t('form.cancel')}</button>
          )}
          {formMsg && <span className={styles.msg}>{formMsg}</span>}
        </div>
      </section>
    </div>
  );
}
