import { accessOrigin } from '../../../../../apps/web/src/lib/sidedoor/access/network/configuration.js';
import { requestFlightParse } from '../../../../../apps/web/src/lib/parsing/client.js';
import type { ParseInput } from '../../../../../apps/web/src/lib/parsing/input.js';
import type { ParseJobStatus } from '../../../../../apps/web/src/lib/parsing/types.js';

export function parseServerTransport(server: string) {
  let origin: string;
  try { origin = accessOrigin(server); }
  catch { throw new Error('Parse server must be an HTTP(S) origin without a path or embedded credentials'); }
  const session = process.env.FLIGHT_FINDER_SESSION;
  const token = process.env.FLIGHT_FINDER_TOKEN;
  if (session && /[^\x21-\x7e]|;/.test(session)) throw new Error('FLIGHT_FINDER_SESSION must contain only the ft-session cookie value');
  if (token && /[^\x21-\x7e]/.test(token)) throw new Error('FLIGHT_FINDER_TOKEN must contain only printable token characters');
  return (path: string, init: RequestInit): Promise<Response> => {
    if (!/^\/api\/parse(?:\/[A-Za-z0-9%_-]+)?$/.test(path)) throw new Error('Invalid parse API path');
    const headers = new Headers(init.headers);
    headers.set('Origin', origin);
    if (session) headers.set('Cookie', `ft-session=${session}`);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(new URL(path, origin), { ...init, headers, redirect: 'error' });
  };
}

export async function parseOnServer(input: ParseInput, background: boolean, server: string, signal: AbortSignal, onJob: (job: ParseJobStatus | null) => void) {
  const response = await requestFlightParse(input, background, signal, onJob, parseServerTransport(server));
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
