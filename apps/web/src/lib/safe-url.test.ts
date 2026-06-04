import { describe, it, expect } from 'vitest';
import { safeHttpUrl } from './safe-url';

describe('safeHttpUrl', () => {
  it('passes through http and https URLs unchanged', () => {
    expect(safeHttpUrl('https://example.com/book?x=1')).toBe('https://example.com/book?x=1');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
  });

  it('rejects dangerous schemes', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBe('');
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(safeHttpUrl('file:///etc/passwd')).toBe('');
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBe('');
  });

  it('returns empty for null, undefined, and empty string', () => {
    expect(safeHttpUrl(null)).toBe('');
    expect(safeHttpUrl(undefined)).toBe('');
    expect(safeHttpUrl('')).toBe('');
  });

  it('returns empty for non-URL or relative strings', () => {
    expect(safeHttpUrl('not a url')).toBe('');
    expect(safeHttpUrl('/relative/path')).toBe('');
  });
});
