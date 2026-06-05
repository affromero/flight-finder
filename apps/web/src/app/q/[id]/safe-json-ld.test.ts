import { describe, it, expect } from 'vitest';
import { safeJsonLd } from './safe-json-ld';

describe('safeJsonLd', () => {
  it('escapes a closing script tag so it cannot terminate the <script> element', () => {
    // H1 stored XSS: a route name carrying "</script>" used to break out of
    // the JSON-LD script tag because JSON.stringify leaves angle brackets raw.
    const payload = {
      name: '</script><script>alert(document.cookie)</script>',
    };
    const output = safeJsonLd(payload);

    expect(output).not.toContain('</script>');
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('<');
    expect(output).not.toContain('>');
    expect(output).toContain('\\u003c');
    expect(output).toContain('\\u003e');
  });

  it('escapes ampersands so HTML entities cannot be smuggled in', () => {
    const output = safeJsonLd({ name: 'Paris & London' });
    expect(output).not.toContain('&');
    expect(output).toContain('\\u0026');
  });

  it('produces JSON that parses back to the original value', () => {
    const payload = {
      '@context': 'https://schema.org',
      name: '</script> & <b>Tokyo</b>',
      nested: { items: [1, 2, 'a > b'] },
    };
    expect(JSON.parse(safeJsonLd(payload))).toEqual(payload);
  });

  it('leaves safe content otherwise intact', () => {
    const output = safeJsonLd({ name: 'New York to Tokyo Flight Prices' });
    expect(JSON.parse(output)).toEqual({ name: 'New York to Tokyo Flight Prices' });
  });
});
