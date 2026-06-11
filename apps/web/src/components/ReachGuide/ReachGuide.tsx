'use client';

import { useEffect, useState } from 'react';
import styles from './ReachGuide.module.css';

type OS = 'macos' | 'linux' | 'windows';

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
  label: string;
  badge: string;
  blurb: string;
  steps: (ctx: MethodCtx) => Step[];
}

const METHODS: Method[] = [
  {
    id: 'lan',
    label: 'Same Wi-Fi',
    badge: 'http · local only',
    blurb: 'Fastest to set up. Reachable by devices on your network. Not encrypted, and phones cannot install it as an app.',
    steps: ({ os, port, host, onLocalhost }) =>
      onLocalhost
        ? [
            {
              text: "You're viewing this on localhost, which phones can't reach. Find this machine's network IP:",
              code:
                os === 'macos'
                  ? 'ipconfig getifaddr en0'
                  : os === 'windows'
                    ? 'ipconfig   (use the IPv4 Address)'
                    : 'hostname -I | awk \'{print $1}\'',
            },
            { text: 'On your phone (same Wi-Fi), open that address with the port:', code: `http://<that-ip>:${port}` },
            { text: 'Leave the Public URL field below empty for this mode.' },
          ]
        : [
            { text: 'Open this exact address on your phone (it must be on the same Wi-Fi):', code: `http://${host}` },
            { text: 'Leave the Public URL field below empty for this mode.' },
          ],
  },
  {
    id: 'tailscale',
    label: 'Tailscale',
    badge: 'https · private',
    blurb: 'A private, encrypted URL only your own devices can reach. No public exposure and no domain required.',
    steps: ({ port }) => [
      { text: 'Install Tailscale on this machine and your phone, signed into the same account:', code: 'https://tailscale.com/download' },
      { text: 'Bring this machine onto your tailnet:', code: 'sudo tailscale up' },
      { text: 'Serve this app over HTTPS on your tailnet:', code: `sudo tailscale serve ${port}` },
      { text: 'Tailscale prints an https URL ending in .ts.net — paste it into Public URL below.' },
    ],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Tunnel',
    badge: 'https · public',
    blurb: 'A public https URL. A quick tunnel takes seconds with no account; a named tunnel gives a permanent URL on your domain.',
    steps: ({ os, port }) => [
      {
        text: 'Install cloudflared:',
        code:
          os === 'macos'
            ? 'brew install cloudflared'
            : os === 'windows'
              ? 'winget install --id Cloudflare.cloudflared'
              : 'sudo apt install cloudflared',
      },
      {
        text: 'Quick, temporary URL (no account): start a tunnel, then copy the https://<name>.trycloudflare.com address it prints and paste it below.',
        code: `cloudflared tunnel --url http://localhost:${port}`,
      },
      {
        text: 'Permanent URL on your own domain (needs a free Cloudflare account with your domain added to it): log in, create a named tunnel, point a DNS record at it, then run it.',
        code: [
          'cloudflared tunnel login',
          'cloudflared tunnel create flight-finder',
          'cloudflared tunnel route dns flight-finder flights.yourdomain.com',
          `cloudflared tunnel run --url http://localhost:${port} flight-finder`,
        ].join('\n'),
      },
      { text: 'Paste your https URL into Public URL below.' },
    ],
  },
  {
    id: 'domain',
    label: 'Your own domain',
    badge: 'https · permanent',
    blurb: 'A permanent https URL on a domain you own, via Caddy — certificates are issued automatically.',
    steps: ({ port }) => [
      { text: "Point an A record for your (sub)domain at this server's public IP." },
      { text: 'Install Caddy:', code: 'https://caddyserver.com/docs/install' },
      { text: 'Create a Caddyfile:', code: `flights.example.com {\n  reverse_proxy localhost:${port}\n}` },
      { text: "Start Caddy — it fetches a Let's Encrypt certificate automatically:", code: 'caddy run' },
      { text: 'Paste https://flights.example.com into Public URL below.' },
    ],
  },
];

const OS_LABELS: Record<OS, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows' };

export function ReachGuide() {
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
  const steps = method.steps({ os, port, host, onLocalhost });
  // OS-specific commands appear in the LAN method (only on localhost) and the
  // Cloudflare install line, so only show the OS switch then.
  const osMatters = (selected === 'lan' && onLocalhost) || selected === 'cloudflare';

  return (
    <div className={styles.root}>
      <div className={styles.methods} role="tablist" aria-label="Reach method">
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={selected === m.id}
            className={`${styles.method} ${selected === m.id ? styles.methodActive : ''}`}
            onClick={() => setSelected(m.id)}
          >
            <span className={styles.methodLabel}>{m.label}</span>
            <span className={styles.methodBadge}>{m.badge}</span>
          </button>
        ))}
      </div>

      <p className={styles.blurb}>{method.blurb}</p>

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
