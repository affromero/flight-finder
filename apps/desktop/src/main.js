// Flight Finder launcher UI. Talks to the Rust commands in src-tauri/src/lib.rs
// via the global Tauri bridge (app.withGlobalTauri = true). Two modes, chosen on
// first launch and remembered in localStorage:
//   host   -- orchestrate the local Docker stack (install/start/stop/open)
//   client -- open a remote instance (a VPS) in its own native window
const invoke = window.__TAURI__.core.invoke;

// install.sh defaults the host port to 3003. A custom HOST_PORT install would
// need this changed; the launcher targets the default.
const HOST_PORT = 3003;
const MODE_KEY = 'ff-desktop-mode';

const $ = (id) => document.getElementById(id);
const views = { chooser: $('chooser'), host: $('host'), client: $('client') };

function show(view) {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
}

function setMode(mode) {
  if (mode) localStorage.setItem(MODE_KEY, mode);
  else localStorage.removeItem(MODE_KEY);
  route();
}

function route() {
  const mode = localStorage.getItem(MODE_KEY);
  if (mode === 'host') {
    show('host');
    refreshHost();
  } else if (mode === 'client') {
    show('client');
    initClient();
  } else {
    show('chooser');
  }
}

$('choose-host').addEventListener('click', () => setMode('host'));
$('choose-client').addEventListener('click', () => setMode('client'));
document
  .querySelectorAll('[data-switch]')
  .forEach((b) => b.addEventListener('click', () => setMode(null)));

// ---- Host mode ----
const host = {
  dot: $('dot'),
  text: $('status-text'),
  actions: $('host-actions'),
  install: $('install'),
  start: $('start'),
  stop: $('stop'),
  restart: $('restart'),
  open: $('open'),
  configHint: $('config-hint'),
  needsDocker: $('needs-docker'),
  reach: $('reach'),
  reachInfo: $('reach-info'),
};

function setStatus(state, text) {
  host.dot.className = `dot dot-${state}`;
  host.text.textContent = text;
}

async function refreshHost() {
  const [hasDocker, isInstalled] = await Promise.all([
    invoke('docker_available'),
    invoke('installed'),
  ]);
  host.needsDocker.hidden = hasDocker;
  host.actions.hidden = !hasDocker;
  host.reach.hidden = true; // re-shown below only when the stack is healthy
  host.restart.hidden = true; // re-shown below only when the stack is healthy
  host.configHint.hidden = true; // only meaningful once installed
  if (!hasDocker) return setStatus('idle', 'Docker not found');

  if (!isInstalled) {
    setStatus('idle', 'Not installed yet');
    host.install.hidden = false;
    host.start.hidden = true;
    host.stop.hidden = true;
    host.open.hidden = true;
    return;
  }

  host.install.hidden = true;
  // Once installed, point the user at the .env they edit and restart to apply.
  host.configHint.hidden = false;
  const healthy = await invoke('is_healthy', { port: HOST_PORT });
  // The reach choices only make sense once the instance is actually up.
  host.reach.hidden = !healthy;
  if (healthy) {
    setStatus('up', 'Running');
    host.start.hidden = true;
    host.stop.hidden = false;
    host.restart.hidden = false;
    host.open.hidden = false;
  } else {
    setStatus('idle', 'Stopped');
    host.start.hidden = false;
    host.stop.hidden = true;
    host.open.hidden = true;
  }
}

async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await invoke('is_healthy', { port: HOST_PORT })) return true;
  }
  return false;
}

host.install.addEventListener('click', async () => {
  setStatus('working', 'Installing… first run pulls images, this can take a few minutes');
  host.install.disabled = true;
  try {
    await invoke('install_stack');
    await waitHealthy();
  } catch (e) {
    setStatus('idle', `Install failed: ${e}`);
  } finally {
    host.install.disabled = false;
    refreshHost();
  }
});

host.start.addEventListener('click', async () => {
  setStatus('working', 'Starting…');
  host.start.disabled = true;
  try {
    await invoke('start_stack');
    await waitHealthy();
  } catch (e) {
    setStatus('idle', `Could not start: ${e}`);
  } finally {
    host.start.disabled = false;
    refreshHost();
  }
});

host.stop.addEventListener('click', async () => {
  setStatus('working', 'Stopping…');
  try {
    await invoke('stop_stack');
  } catch (e) {
    setStatus('idle', `Could not stop: ${e}`);
  } finally {
    refreshHost();
  }
});

host.restart.addEventListener('click', async () => {
  setStatus('working', 'Restarting…');
  host.restart.disabled = true;
  try {
    // Recreates the containers so an edited .env is reloaded (a plain start
    // would not pick up env_file changes).
    await invoke('restart_stack');
    await waitHealthy();
  } catch (e) {
    setStatus('idle', `Restart failed: ${e}`);
  } finally {
    host.restart.disabled = false;
    refreshHost();
  }
});

host.open.addEventListener('click', () => invoke('open_app', { port: HOST_PORT }));

// Reachability: consent-first. "This computer only" is the default; nothing is
// exposed unless the user picks LAN or a public tunnel.
const reachConfirm = $('reach-confirm');
const reachStop = $('reach-stop');

function selectReach(choice) {
  document.querySelectorAll('.reach-opt').forEach((b) => {
    b.classList.toggle('reach-active', b.dataset.reach === choice);
  });
}

function hideReachButtons() {
  reachConfirm.hidden = true;
  reachStop.hidden = true;
}

document.querySelector('[data-reach="local"]').addEventListener('click', async () => {
  selectReach('local');
  hideReachButtons();
  await invoke('stop_tunnel').catch(() => {});
  host.reachInfo.textContent = 'Only this computer can reach it.';
});

document.querySelector('[data-reach="lan"]').addEventListener('click', async () => {
  selectReach('lan');
  hideReachButtons();
  await invoke('stop_tunnel').catch(() => {});
  const url = await invoke('lan_url', { port: HOST_PORT });
  host.reachInfo.textContent = url
    ? `On your WiFi: ${url} — opens on other devices, but http so it can't be installed as an app.`
    : 'Could not determine your local network address.';
});

// Two-step, in-app consent (Tauri's webview has no window.confirm).
document.querySelector('[data-reach="public"]').addEventListener('click', () => {
  selectReach('public');
  reachStop.hidden = true;
  reachConfirm.hidden = false;
  host.reachInfo.textContent =
    'Opens a temporary PUBLIC https URL to this computer — anyone with the link can reach it until you stop it. Click "Open public link" to confirm.';
});

reachConfirm.addEventListener('click', async () => {
  reachConfirm.hidden = true;
  host.reachInfo.textContent = 'Opening a public link…';
  try {
    const url = await invoke('start_tunnel', { port: HOST_PORT });
    host.reachInfo.textContent = `Public link: ${url} — open it on your phone, then Add to Home Screen.`;
    reachStop.hidden = false;
  } catch (e) {
    selectReach('local');
    host.reachInfo.textContent = String(e);
  }
});

reachStop.addEventListener('click', async () => {
  await invoke('stop_tunnel').catch(() => {});
  selectReach('local');
  hideReachButtons();
  host.reachInfo.textContent = 'Public link stopped. Only this computer can reach it.';
});

// ---- Client mode ----
const client = { url: $('server-url'), connect: $('connect'), error: $('client-error') };
let clientInited = false;

async function initClient() {
  if (clientInited) return;
  clientInited = true;
  const saved = await invoke('load_server');
  if (saved) client.url.value = saved;
}

client.connect.addEventListener('click', async () => {
  client.error.hidden = true;
  const url = client.url.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    client.error.textContent = 'Enter a full URL starting with http:// or https://';
    client.error.hidden = false;
    return;
  }
  try {
    await invoke('save_server', { url });
    await invoke('open_client', { url });
  } catch (e) {
    client.error.textContent = String(e);
    client.error.hidden = false;
  }
});

// Keep the host status fresh while that view is showing.
setInterval(() => {
  if (localStorage.getItem(MODE_KEY) === 'host' && !views.host.hidden) refreshHost();
}, 5000);

route();
