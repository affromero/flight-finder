import { apiError, apiSuccess } from '@/lib/api-response';
import { accessHandler } from './access';

export function withAccessBody(request: Request, body: unknown): Request {
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });
}

/** Adapt shared access responses to this application's established API envelope. */
export async function accessRouteResponse(
  request: Request,
  action: string,
  body?: unknown,
  data: (payload: unknown) => Record<string, unknown> = () => ({ ok: true })
) {
  const forwarded = body === undefined ? request : withAccessBody(request, body);
  const response = await (await accessHandler())(forwarded, action);
  const payload: unknown = await response.json();
  const result = response.ok
    ? apiSuccess(data(payload))
    : apiError(
        payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          typeof payload.error === 'string'
          ? payload.error
          : 'Access request failed',
        response.status
      );
  result.headers.set('cache-control', 'no-store');
  for (const cookie of response.headers.getSetCookie()) result.headers.append('set-cookie', cookie);
  const retry = response.headers.get('retry-after');
  if (retry) result.headers.set('retry-after', retry);
  return result;
}
