'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { AirportResult } from '@/app/api/airports/route';
import styles from './AirportCombobox.module.css';

interface AirportComboboxProps {
  id: string;
  label: string;
  placeholder?: string;
  value: { code: string; name: string } | null;
  onChange: (value: { code: string; name: string } | null) => void;
  error?: string;
  autoFocus?: boolean;
  excludeCode?: string;
}

export function AirportCombobox({
  id,
  label,
  placeholder,
  value,
  onChange,
  error,
  autoFocus,
  excludeCode,
}: AirportComboboxProps) {
  const t = useTranslations('AirportCombobox');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AirportResult[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const displayValue = value ? `${value.code} - ${value.name}` : query;

  const fetchResults = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/airports?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (json.ok) {
        const filtered = excludeCode
          ? json.data.filter((r: AirportResult) => r.code !== excludeCode)
          : json.data;
        setResults(filtered);
        setOpen(filtered.length > 0);
        setActiveIndex(-1);
      }
    } finally {
      setLoading(false);
    }
  }, [excludeCode]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (value) onChange(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchResults(val), 150);
  };

  const handleSelect = (result: AirportResult) => {
    onChange({ code: result.code, name: `${result.city} (${result.name})` });
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && results[activeIndex]) {
          handleSelect(results[activeIndex]);
        }
        break;
      case 'Escape':
        setOpen(false);
        setActiveIndex(-1);
        break;
    }
  };

  const handleFocus = () => {
    if (value) {
      setQuery(value.name.split(' (')[0] || '');
      onChange(null);
    }
    if (query.length >= 2) {
      fetchResults(query);
    }
  };

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <div className={styles.inputWrapper}>
        <input
          ref={inputRef}
          id={id}
          className={`${styles.input} ${error ? styles.inputError : ''} ${value ? styles.inputSelected : ''}`}
          type="text"
          placeholder={placeholder ?? t('placeholder')}
          value={value ? displayValue : query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          autoFocus={autoFocus}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          aria-invalid={!!error}
        />
        {loading && <span className={styles.spinner} aria-hidden="true" />}
      </div>
      {error && <span className={styles.errorText}>{error}</span>}
      {open && results.length > 0 && (
        <ul
          id={`${id}-listbox`}
          className={styles.dropdown}
          role="listbox"
          aria-label={t('suggestions', { label })}
        >
          {results.map((r, i) => (
            <li
              key={r.code}
              id={`${id}-option-${i}`}
              className={`${styles.option} ${i === activeIndex ? styles.optionActive : ''}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(r)}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className={styles.optionCode}>{r.code}</span>
              <span className={styles.optionName}>{r.city} - {r.name}</span>
              <span className={styles.optionCountry}>{r.country}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
