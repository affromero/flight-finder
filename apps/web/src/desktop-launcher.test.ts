/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Exercises the real Tauri desktop launcher UI (apps/desktop/src) from the web
// test runner so it runs in `npm run ci`. The desktop package is intentionally
// minimal (no JS test runner of its own), and main.js is plain DOM glue, so we
// load the actual index.html + main.js into jsdom with a mocked Tauri bridge
// and assert the behavior that #151 added: the Restart button and the .env
// hint show only in the right states, and Restart invokes restart_stack.

const desktopSrc = resolve(dirname(fileURLToPath(import.meta.url)), '../../desktop/src');
const html = readFileSync(resolve(desktopSrc, 'index.html'), 'utf8');
const mainJs = readFileSync(resolve(desktopSrc, 'main.js'), 'utf8');
const bodyInner = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)![1] ?? '';

type Responses = Record<string, unknown>;

// jsdom in this config exposes a `localStorage` object with no methods, so give
// main.js (route() reads it on load) a working in-memory one.
function installLocalStorage() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true, writable: true });
}

/** Render the real launcher markup, mock the Tauri bridge, and run main.js.
 *  main.js is a non-module script: `new Function` runs it (its listeners close
 *  over the same `invoke`) and returns the handles the tests drive. */
function loadLauncher(responses: Responses) {
  document.body.innerHTML = bodyInner; // <script> in innerHTML does not execute in jsdom
  installLocalStorage();
  const invoke = vi.fn((cmd: string) => Promise.resolve(responses[cmd]));
  (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
  const factory = new Function(`${mainJs}\nreturn { refreshHost, setMode };`);
  const api = factory() as { refreshHost: () => Promise<void>; setMode: (m: string | null) => void };
  return { invoke, api };
}

const el = (id: string) => document.getElementById(id)!;

describe('desktop launcher UI (#151)', () => {
  beforeEach(() => {
    // Freeze main.js's 5s refresh interval and waitHealthy's 1.5s sleep.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows Restart and the .env hint when the stack is running', async () => {
    const { api } = loadLauncher({ docker_available: true, installed: true, is_healthy: true });
    await api.refreshHost();
    expect(el('restart').hidden).toBe(false);
    expect(el('config-hint').hidden).toBe(false);
    expect(el('stop').hidden).toBe(false);
    expect(el('start').hidden).toBe(true);
  });

  it('hides Restart when installed but stopped, still showing the .env hint', async () => {
    const { api } = loadLauncher({ docker_available: true, installed: true, is_healthy: false });
    await api.refreshHost();
    expect(el('restart').hidden).toBe(true);
    expect(el('start').hidden).toBe(false);
    expect(el('config-hint').hidden).toBe(false);
  });

  it('hides Restart and the .env hint when not installed', async () => {
    const { api } = loadLauncher({ docker_available: true, installed: false });
    await api.refreshHost();
    expect(el('restart').hidden).toBe(true);
    expect(el('config-hint').hidden).toBe(true);
  });

  it('clicking Restart invokes restart_stack', async () => {
    const { invoke, api } = loadLauncher({ docker_available: true, installed: true, is_healthy: true });
    await api.refreshHost();
    invoke.mockClear();
    el('restart').dispatchEvent(new window.Event('click'));
    expect(invoke).toHaveBeenCalledWith('restart_stack');
  });
});
