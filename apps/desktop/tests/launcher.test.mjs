import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function launcher(overrides = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, textContent: '', value: '', dataset: {}, handlers: {},
      classList: { toggle() {} }, addEventListener(event, callback) { this.handlers[event] = callback; },
    });
    return elements.get(id);
  }
  const reach = ['local', 'lan', 'public'].map(kind => { const value = element(`reach-${kind}`); value.dataset.reach = kind; return value; });
  const calls = [];
  const responses = { docker_available: true, installed: true, is_healthy: true, connection: { port: 3017, localOnly: false }, lan_url: 'http://192.0.2.2:3017', ...overrides };
  runInNewContext(source, {
    window: { __TAURI__: { core: { invoke: async (name, args) => {
      calls.push({ name, args });
      const result = responses[name];
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(args) : result;
    } } } },
    document: { getElementById: element, querySelectorAll: selector => selector === '.reach-opt' ? reach : [],
      querySelector: selector => element(`reach-${selector.match(/"(\w+)"/)[1]}`) },
    localStorage: { getItem: () => 'host', setItem() {}, removeItem() {} },
    setInterval() {}, setTimeout: callback => { callback(); return 0; }, console,
  });
  return { element, calls, responses, click: id => element(id).handlers.click() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('uses the installed connection and never supplies a hardcoded port to native commands', async () => {
  const app = launcher(); await settle();
  assert.equal(app.element('status-text').textContent, 'Running');
  assert.match(app.element('reach-info').textContent, /local network/);
  await app.click('open');
  assert.equal(app.calls.find(call => call.name === 'open_app').args, undefined);
  assert.equal(app.calls.find(call => call.name === 'is_healthy').args, undefined);
});

test('a local-only choice changes the binding before claiming local access', async () => {
  let complete;
  const app = launcher({ set_reach: () => new Promise(resolve => { complete = resolve; }) });
  await settle();
  const changing = app.click('reach-local');
  assert.match(app.element('reach-info').textContent, /local network/);
  assert.equal(app.calls.find(call => call.name === 'set_reach').args.localOnly, true);
  complete({ port: 3017, localOnly: true }); await changing;
  assert.match(app.element('reach-info').textContent, /Only this computer/);
});

test('failed binding changes retain the actual access description and report the error', async () => {
  const app = launcher({ set_reach: new Error('Compose override still exposes the port') }); await settle();
  await app.click('reach-local');
  assert.match(app.element('host-error').textContent, /override still exposes/);
  assert.match(app.element('reach-info').textContent, /local network/);
});

test('installer failures remain visible after status refresh', async () => {
  const app = launcher({ installed: false, install_stack: new Error('Download failed') }); await settle();
  await app.click('install'); await settle();
  assert.match(app.element('host-error').textContent, /Download failed/);
  assert.equal(app.element('status-text').textContent, 'Not installed yet');
});

test('starting a stack that never becomes healthy reports the deadline failure', async () => {
  const app = launcher({ is_healthy: false }); await settle();
  await app.click('start'); await settle();
  assert.match(app.element('host-error').textContent, /did not become healthy/);
  assert.equal(app.element('open').hidden, true);
});

test('failed tunnel shutdown never claims that public exposure stopped', async () => {
  const app = launcher({ start_tunnel: 'https://fixture.trycloudflare.com', stop_tunnel: new Error('Could not stop owned process') }); await settle();
  app.click('reach-public'); await app.click('reach-confirm');
  await app.click('reach-stop');
  assert.match(app.element('host-error').textContent, /Could not stop/);
  assert.match(app.element('reach-info').textContent, /Public link:/);
  assert.equal(app.element('reach-stop').hidden, false);
});

test('restart closes the old public tunnel before applying an edited port', async () => {
  const app = launcher({ start_tunnel: 'https://fixture.trycloudflare.com' }); await settle();
  app.click('reach-public'); await app.click('reach-confirm');
  await app.click('restart'); await settle();
  const stopped = app.calls.findIndex(call => call.name === 'stop_tunnel');
  const restarted = app.calls.findIndex(call => call.name === 'restart_stack');
  assert.ok(stopped >= 0 && stopped < restarted);
  assert.equal(app.element('reach-stop').hidden, true);
  assert.doesNotMatch(app.element('reach-info').textContent, /Public link:/);
});
