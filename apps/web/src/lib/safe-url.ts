/**
 * Return the URL only when it is a plain http(s) URL, otherwise an empty string.
 * Guards hrefs and notification links against javascript:/data:/file: and other
 * schemes — React does not strip those from an href in production, and booking
 * URLs are LLM-extracted (untrusted), so any place that renders one as a link
 * must run it through here first.
 */
export function safeHttpUrl(u: string | null | undefined): string {
  if (!u) return '';
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? u : '';
  } catch {
    return '';
  }
}
