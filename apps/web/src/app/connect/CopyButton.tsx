'use client';

import { useState } from 'react';
import styles from './page.module.css';

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context or denied): leave the URL visible
      // for manual copy rather than failing silently with a broken button.
      setCopied(false);
    }
  };

  return (
    <button type="button" className={styles.copy} onClick={copy} aria-live="polite">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
