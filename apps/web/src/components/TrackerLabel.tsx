'use client';

import { useState, useRef } from 'react';
import { getDeleteToken } from '@/lib/tracker-storage';
import styles from './TrackerLabel.module.css';

interface Props {
  queryId: string;
  currentLabel: string | null;
  // Server-resolved: this viewer may edit even without a local delete token
  // (self-hosted solo, admin, or owner). See canManageQueryWithoutToken.
  canEdit?: boolean;
}

export function TrackerLabel({ queryId, currentLabel, canEdit = false }: Props) {
  const [label, setLabel] = useState(currentLabel);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentLabel ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const token = typeof window !== 'undefined' ? getDeleteToken(queryId) : null;

  const save = async (value: string) => {
    const trimmed = value.trim();
    const newLabel = trimmed || null;
    if (newLabel === label) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/queries/${queryId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: token, label: newLabel }),
      });
      const data = await res.json();
      if (data.ok) {
        setLabel(newLabel);
      }
    } catch {
      // keep previous state
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  const startEditing = () => {
    setDraft(label ?? '');
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  if (!token && !canEdit) {
    if (!label) return null;
    return (
      <div className={styles.root}>
        <span className={styles.display} style={{ cursor: 'default' }}>{label}</span>
      </div>
    );
  }

  if (editing) {
    return (
      <div className={styles.root}>
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => save(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save(draft);
            if (e.key === 'Escape') setEditing(false);
          }}
          maxLength={60}
          placeholder="e.g. Paris via Skyscanner"
          disabled={saving}
        />
      </div>
    );
  }

  if (label) {
    return (
      <div className={styles.root}>
        <span className={styles.display} onClick={startEditing} title="Click to edit label">
          {label}
        </span>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <button className={styles.addButton} onClick={startEditing} type="button">
        + Add label
      </button>
    </div>
  );
}
