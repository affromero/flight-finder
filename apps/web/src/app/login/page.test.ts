import { describe, it, expect } from 'vitest';
import { sanitizeNext } from '@/lib/safe-next';

describe('sanitizeNext', () => {
  it('returns null for undefined', () => {
    expect(sanitizeNext(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(sanitizeNext(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(sanitizeNext('')).toBeNull();
  });

  it('returns a valid same-site path unchanged', () => {
    expect(sanitizeNext('/account')).toBe('/account');
    expect(sanitizeNext('/admin/queries')).toBe('/admin/queries');
  });

  it('returns null for an absolute URL (off-site redirect)', () => {
    expect(sanitizeNext('https://evil.example.com/steal')).toBeNull();
  });

  it('returns null for a protocol-relative URL starting with //', () => {
    expect(sanitizeNext('//evil.example.com')).toBeNull();
  });

  it('returns null for a slash-backslash bypass (/\\evil.example.com)', () => {
    expect(sanitizeNext('/\\evil.example.com')).toBeNull();
  });

  it('returns null when the value contains a tab character', () => {
    expect(sanitizeNext('/account\t')).toBeNull();
    expect(sanitizeNext('/acco\tunt')).toBeNull();
  });

  it('returns null when the value contains a newline (LF)', () => {
    expect(sanitizeNext('/account\n')).toBeNull();
  });

  it('returns null when the value contains a carriage return (CR)', () => {
    expect(sanitizeNext('/account\r')).toBeNull();
  });

  it('returns null when the value contains a null byte', () => {
    expect(sanitizeNext('/account\x00')).toBeNull();
  });

  it('returns null when the value contains another C0 control character', () => {
    // U+001F (unit separator) is still a C0 control character.
    expect(sanitizeNext('/account\x1F')).toBeNull();
  });

  it('accepts paths with query strings and fragments', () => {
    expect(sanitizeNext('/account?ref=1')).toBe('/account?ref=1');
    expect(sanitizeNext('/q/abc#chart')).toBe('/q/abc#chart');
  });
});
