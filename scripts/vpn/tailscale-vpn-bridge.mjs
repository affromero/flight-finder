import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

const execute = promisify(execFile);

/** No shell, bounded output, and cancellation for every subprocess. */
async function run(file, args, signal) {
  const { stdout } = await execute(file, args, { signal, timeout: 15_000, maxBuffer: 4_194_304, killSignal: 'SIGKILL' });
  signal.throwIfAborted();
  return stdout;
}

function mullvadPeers(raw) {
  if (raw?.BackendState !== 'Running' || raw.TUN !== false || !raw.Peer || typeof raw.Peer !== 'object' || Array.isArray(raw.Peer)) {
    throw new Error('Tailscale must be authenticated and running in userspace mode');
  }
  const peers = Object.values(raw.Peer).filter(peer => peer?.ExitNodeOption === true && peer.Online === true && peer.Expired !== true
    && typeof peer.ID === 'string' && peer.ID && typeof peer.DNSName === 'string'
    && /^[a-z0-9-]+\.mullvad\.ts\.net\.?$/.test(peer.DNSName)
    && typeof peer.Location?.CountryCode === 'string' && /^[A-Z]{2}$/i.test(peer.Location.CountryCode)
    && Array.isArray(peer.TailscaleIPs) && peer.TailscaleIPs.length > 0
    && peer.TailscaleIPs.every(ip => typeof ip === 'string' && isIP(ip)))
    .sort((a, b) => a.DNSName.localeCompare(b.DNSName));
  const ids = peers.map(peer => peer.ID), ips = peers.flatMap(peer => peer.TailscaleIPs);
  if (new Set(ids).size !== ids.length || new Set(ips).size !== ips.length) throw new Error('Ambiguous exit node identity');
  return peers;
}

function observation(raw) {
  const peers = mullvadPeers(raw);
  if (raw.ExitNodeStatus == null) {
    if (Object.values(raw.Peer).some(peer => peer?.ExitNode === true)) throw new Error('Conflicting exit node status');
    return { connected: false, currentLocation: null, currentCountry: null };
  }
  const selected = peers.find(peer => peer.ID === raw.ExitNodeStatus.ID);
  if (!selected || raw.ExitNodeStatus.Online !== true || selected.ExitNode !== true
    || Object.values(raw.Peer).filter(peer => peer?.ExitNode === true).length !== 1) throw new Error('Selected Mullvad exit node is unavailable');
  return { connected: true, currentLocation: selected.DNSName, currentCountry: selected.Location.CountryCode.toUpperCase() };
}

/** Private Docker-network API. Only mount a dedicated daemon's socket here. */
export function createTailscaleVpnBridge({
  command = run,
  socket = process.env.TAILSCALE_SOCKET || '/var/run/tailscale/tailscaled.sock',
  proxy = process.env.TAILSCALE_VPN_SOCKS_URL || 'socks5://tailscale:1055',
  pollMs = 500,
  deadlineMs = 45_000,
} = {}) {
  const proxyUrl = new URL(proxy);
  if (proxyUrl.protocol !== 'socks5:' || !proxyUrl.hostname || proxyUrl.username || proxyUrl.password || proxyUrl.search || proxyUrl.hash
    || !['', '/'].includes(proxyUrl.pathname)) throw new Error('A dedicated Tailscale SOCKS5 proxy is required');
  const proxyIdentity = proxyUrl.href;
  proxyUrl.protocol = 'socks5h:'; // Resolve the probe's hostname through the same proxy as Chromium.
  const cli = (args, signal) => command('tailscale', ['--socket=' + socket, ...args], signal);
  const status = async signal => JSON.parse(await cli(['status', '--json'], signal));
  let mutating = false;
  let uncertain = false;

  async function switchExit(country, signal) {
    const initial = await status(signal);
    const peers = mullvadPeers(initial);
    observation(initial);
    const target = country ? peers.find(peer => peer.Location.CountryCode.toUpperCase() === country) : null;
    if (country && !target) throw new Error('No available Mullvad exit node for ' + country);
    // From here on, an error leaves the outcome uncertain until operator recovery.
    uncertain = true;
    await cli(['set', '--exit-node=' + (target?.TailscaleIPs.find(ip => isIP(ip)) || '')], signal);
    let observed;
    while (true) {
      const raw = await status(signal);
      observed = observation(raw);
      if (target ? raw.ExitNodeStatus?.ID === target.ID && observed.connected : !observed.connected) break;
      await pause(pollMs, undefined, { signal });
    }
    let exitIp;
    if (target) {
      const probe = JSON.parse(await command('curl', [
        '--silent', '--show-error', '--fail', '--max-time', '12', '--noproxy', '',
        '--proxy', proxyUrl.href, 'https://am.i.mullvad.net/json',
      ], signal));
      if (probe?.mullvad_exit_ip !== true || typeof probe.ip !== 'string' || !isIP(probe.ip)) throw new Error('Proxy traffic is not exiting through Mullvad');
      exitIp = probe.ip;
      const after = await status(signal);
      if (after.ExitNodeStatus?.ID !== target.ID || !observation(after).connected) throw new Error('Exit node changed during verification');
    }
    signal.throwIfAborted();
    return { success: true, ...observed, proxyUrl: proxyIdentity, ...(exitIp ? { exitIp } : {}) };
  }

  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const send = (code, value) => { res.writeHead(code); res.end(JSON.stringify(value)); };
    const path = req.url;
    const match = /^\/v1\/connect\/([A-Z]{2})$/.exec(path || '');
    const mutation = req.method === 'POST' && (match || path === '/v1/disconnect');
    if (req.headers.origin) { send(403, { error: 'Browser origins are not allowed' }); return; }
    if (uncertain && !mutating) { send(503, { error: 'VPN outcome unconfirmed; verify the dedicated daemon before restarting the bridge' }); return; }
    if (mutating) { send(409, { error: 'VPN operation in progress' }); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), mutation ? deadlineMs : 8_000);
    const closed = () => { if (!res.writableFinished) controller.abort(); };
    res.on('close', closed);
    try {
      if (mutation) {
        mutating = true;
        const result = await switchExit(match?.[1] || null, controller.signal);
        controller.signal.throwIfAborted();
        // Keep the uncertainty latch until the response is handed to the caller.
        await new Promise((resolve, reject) => {
          res.once('finish', resolve);
          res.once('close', () => { if (!res.writableFinished) reject(new Error('Caller disconnected')); });
          send(200, result);
        });
        uncertain = false;
      } else if (req.method === 'GET' && path === '/v1/status') {
        send(200, { ...observation(await status(controller.signal)), proxyUrl: proxyIdentity });
      } else if (req.method === 'GET' && path === '/v1/locations') {
        const peers = mullvadPeers(await status(controller.signal));
        const locations = [...new Set(peers.map(peer => peer.Location.CountryCode.toUpperCase()))].sort().map(country => country + ': Mullvad');
        send(200, { locations, proxyUrl: proxyIdentity });
      } else send(404, { error: 'Unknown VPN operation' });
    } catch {
      // Do not expose daemon output, auth URLs, or credentials in HTTP errors.
      if (!res.headersSent && !res.destroyed) send(502, { error: 'Tailscale VPN operation failed; check authentication, Mullvad access, and exit node availability' });
    } finally {
      clearTimeout(timer);
      res.off('close', closed);
      if (mutation) mutating = false;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.VPN_BRIDGE_PORT || 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid bridge port');
  const bridge = createTailscaleVpnBridge();
  bridge.listen(port, '0.0.0.0', () => console.log('Tailscale VPN bridge listening on port ' + bridge.address().port));
}
