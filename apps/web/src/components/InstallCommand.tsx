'use client';

import { useState } from 'react';
import Link from 'next/link';
import styles from './InstallCommand.module.css';

const COMMAND = 'curl -fsSL https://flight-finder.org/install.sh | bash';

export function InstallCommand() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.root}>
      <div className={styles.codeRow}>
        <code className={styles.code}>{COMMAND}</code>
        <button
          className={styles.copyButton}
          onClick={handleCopy}
          aria-label="Copy to clipboard"
        >
          {copied ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
              <path d="M10.5 5.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h2.5" stroke="currentColor" strokeWidth="1.25" />
            </svg>
          )}
        </button>
      </div>
      <p className={styles.hint}>
        Works with Claude Code, Codex, or any LLM API key.
        No account needed.
      </p>
      <Link href="/download" className={styles.desktopLink}>
        Rather not use the terminal? Get the desktop app
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>
    </div>
  );
}
