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
  open: $('open'),
  needsDocker: $('needs-docker'),
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
  const healthy = await invoke('is_healthy', { port: HOST_PORT });
  if (healthy) {
    setStatus('up', 'Running');
    host.start.hidden = true;
    host.stop.hidden = false;
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

host.open.addEventListener('click', () => invoke('open_app', { port: HOST_PORT }));

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
