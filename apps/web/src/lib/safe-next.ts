/**
 * Returns the value of a 'next' redirect parameter only when it is a safe
 * same-site relative path, otherwise null. Rules:
 *   - Must start with a single forward slash.
 *   - Must NOT start with '//' (protocol-relative URL) or '/\' (IE quirk),
 *     which would navigate off-site.
 *   - Must contain no C0 control characters (tab, CR, LF, etc.) that could
 *     slip past naive prefix checks or confuse header parsers.
 */
export function sanitizeNext(next: string | undefined | null): string | null {
  if (!next) return null;
  if (!next.startsWith('/')) return null;
  if (next.startsWith('//') || next.startsWith('/\\')) return null;
  // Reject any C0 control character (U+0000 through U+001F). Checked by char
  // code rather than a control-character regex literal (which eslint forbids).
  for (let i = 0; i < next.length; i++) {
    if (next.charCodeAt(i) <= 0x1f) return null;
  }
  return next;
}
