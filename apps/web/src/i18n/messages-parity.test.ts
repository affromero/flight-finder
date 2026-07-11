import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCALES, DEFAULT_LOCALE } from './locales';

const MESSAGES_DIR = resolve(__dirname, '../../messages');

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

function localeKeys(locale: string): Map<string, string[]> {
  const files = readdirSync(resolve(MESSAGES_DIR, locale)).filter((f) => f.endsWith('.json'));
  return new Map(
    files.map((file) => [
      file,
      flattenKeys(JSON.parse(readFileSync(resolve(MESSAGES_DIR, locale, file), 'utf-8'))).sort(),
    ]),
  );
}

describe('message key parity across locales', () => {
  const english = localeKeys(DEFAULT_LOCALE);
  const others = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

  it.each(others)('%s has the same files and keys as English', (locale) => {
    const keys = localeKeys(locale);
    expect([...keys.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [file, enKeys] of english) {
      const locKeys = keys.get(file) ?? [];
      const missing = enKeys.filter((k) => !locKeys.includes(k));
      const extra = locKeys.filter((k) => !enKeys.includes(k));
      expect({ file, missing, extra }).toEqual({ file, missing: [], extra: [] });
    }
  });
});
