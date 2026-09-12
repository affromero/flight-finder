import { describe, expect, it } from 'vitest';
import { POST } from './route';
import { FLIGHT_IMPORT_URL } from '@/test/import-fixtures';

const request = (body: unknown) => new Request('http://localhost/api/travel/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
describe('travel link import HTTP boundary', () => {
  it('returns selected flight details for review', async () => {
    const response = await POST(request({ kind: 'flights', url: FLIGHT_IMPORT_URL }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { kind: 'flights', flight: { origin: 'ORD', destination: 'DUS', sourceUrl: FLIGHT_IMPORT_URL } } });
  });
  it.each([{ kind: 'flights', url: 'https://example.com' }, { kind: 'boats', url: FLIGHT_IMPORT_URL }, { kind: 'flights', url: 123 }, []])('rejects unsupported imports without a success envelope', async body => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });
  it('rejects oversized import requests', async () => {
    const response = await POST(request({ kind: 'flights', url: 'x'.repeat(65536) }));
    expect(response.status).toBe(413);
  });
});
