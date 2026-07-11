'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import styles from './ReachGuide.module.css';

type OS = 'macos' | 'linux' | 'windows';
type Translator = ReturnType<typeof useTranslations>;

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'macos';
  if (/Win/i.test(ua)) return 'windows';
  return 'linux';
}

interface Step {
  text: string;
  code?: string;
}

interface MethodCtx {
  os: OS;
  port: string;
  /** host:port the browser is currently using (e.g. "192.168.1.5:3003"). */
  host: string;
  /** true when the current address is localhost/loopback (not shareable). */
  onLocalhost: boolean;
}

interface Method {
  id: string;
  steps: (ctx: MethodCtx, t: Translator) => Step[];
}

const METHODS: Method[] = [
  {
    id: 'lan',
    steps: ({ os, port, host, onLocalhost }, t) =>
      onLocalhost
        ? [
            {
              text: t('lan.findIp'),
              code:
                os === 'macos'
                  ? 'ipconfig getifaddr en0'
                  : os === 'windows'
                    ? 'ipconfig   (use the IPv4 Address)'
                    : 'hostname -I | awk \'{print $1}\'',
            },
            { text: t('lan.openWithPort'), code: `http://<that-ip>:${port}` },
            { text: t('lan.leaveEmpty') },
          ]
        : [
            { text: t('lan.openExact'), code: `http://${host}` },
            { text: t('lan.leaveEmpty') },
          ],
  },
  {
    id: 'tailscale',
    steps: ({ port }, t) => [
      { text: t('tailscale.install'), code: 'https://tailscale.com/download' },
      { text: t('tailscale.up'), code: 'sudo tailscale up' },
      { text: t('tailscale.serve'), code: `sudo tailscale serve ${port}` },
      { text: t('tailscale.paste') },
    ],
  },
  {
    id: 'cloudflare',
    steps: ({ os, port }, t) => [
      {
        text: t('cloudflare.install'),
        code:
          os === 'macos'
            ? 'brew install cloudflared'
            : os === 'windows'
              ? 'winget install --id Cloudflare.cloudflared'
              : 'sudo apt install cloudflared',
      },
      {
        text: t('cloudflare.quick'),
        code: `cloudflared tunnel --url http://localhost:${port}`,
      },
      {
        text: t('cloudflare.permanent'),
        code: [
          'cloudflared tunnel login',
          'cloudflared tunnel create flight-finder',
          'cloudflared tunnel route dns flight-finder flights.yourdomain.com',
          `cloudflared tunnel run --url http://localhost:${port} flight-finder`,
        ].join('\n'),
      },
      { text: t('cloudflare.paste') },
    ],
  },
  {
    id: 'domain',
    steps: ({ port }, t) => [
      { text: t('domain.dns') },
      { text: t('domain.install'), code: 'https://caddyserver.com/docs/install' },
      { text: t('domain.caddyfile'), code: `flights.example.com {\n  reverse_proxy localhost:${port}\n}` },
      { text: t('domain.run'), code: 'caddy run' },
      { text: t('domain.paste') },
    ],
  },
];

const OS_LABELS: Record<OS, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows' };

export function ReachGuide() {
  const t = useTranslations('ReachGuide');
  const [os, setOs] = useState<OS>('linux');
  const [selected, setSelected] = useState<string>('tailscale');
  const [port, setPort] = useState('3003');
  const [host, setHost] = useState('localhost:3003');
  const [onLocalhost, setOnLocalhost] = useState(true);

  useEffect(() => {
    setOs(detectOS());
    if (typeof window !== 'undefined') {
      setPort(window.location.port || '3003');
      setHost(window.location.host);
      setOnLocalhost(/^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(window.location.hostname));
    }
  }, []);

  const method = METHODS.find((m) => m.id === selected) ?? METHODS[0]!;
  const steps = method.steps({ os, port, host, onLocalhost }, t);
  const osMatters = (selected === 'lan' && onLocalhost) || selected === 'cloudflare';

  return (
    <div className={styles.root}>
      <div className={styles.methods} role="tablist" aria-label={t('ariaLabel')}>
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={selected === m.id}
            className={`${styles.method} ${selected === m.id ? styles.methodActive : ''}`}
            onClick={() => setSelected(m.id)}
          >
            <span className={styles.methodLabel}>{t(`${m.id}.label`)}</span>
            <span className={styles.methodBadge}>{t(`${m.id}.badge`)}</span>
          </button>
        ))}
      </div>

      <p className={styles.blurb}>{t(`${method.id}.blurb`)}</p>

      {osMatters && (
        <div className={styles.osRow}>
          {(Object.keys(OS_LABELS) as OS[]).map((o) => (
            <button
              key={o}
              type="button"
              className={`${styles.osBtn} ${os === o ? styles.osBtnActive : ''}`}
              onClick={() => setOs(o)}
            >
              {OS_LABELS[o]}
            </button>
          ))}
        </div>
      )}

      <ol className={styles.steps}>
        {steps.map((s, i) => (
          <li key={i} className={styles.step}>
            <span className={styles.stepText}>{s.text}</span>
            {s.code && <pre className={styles.code}>{s.code}</pre>}
          </li>
        ))}
      </ol>
    </div>
  );
}
