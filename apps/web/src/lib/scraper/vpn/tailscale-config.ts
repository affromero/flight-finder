/** Capture the same dedicated bridge and proxy identities used by admission. */
export function tailscaleVpnConfig() {
  const api = new URL(process.env.TAILSCALE_VPN_API_URL || 'http://tailscale-vpn:8000');
  const proxy = new URL(process.env.TAILSCALE_VPN_SOCKS_URL || 'socks5://tailscale:1055');
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash
    || !['', '/'].includes(api.pathname)) throw new Error('Invalid Tailscale VPN API configuration');
  if (proxy.protocol !== 'socks5:' || !proxy.hostname || proxy.username || proxy.password || proxy.search || proxy.hash
    || !['', '/'].includes(proxy.pathname)) throw new Error('Invalid Tailscale SOCKS5 configuration');
  return { apiUrl: api.origin, proxyUrl: proxy.href };
}
