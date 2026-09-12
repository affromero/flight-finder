/** Self-hosted alerts need an explicit public URL; otherwise omit the local link. */
export function resolveBaseUrl(publicBaseUrl?: string | null): string | null {
  const configured = publicBaseUrl || process.env.APP_URL;
  if (configured) return configured.replace(/\/+$/, '');
  if (process.env.SELF_HOSTED === 'true') return null;
  return 'https://flight-finder.org';
}
