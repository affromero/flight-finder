/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CliModelPicker } from './CliModelPicker';

const fetchMock = vi.fn();
const props = { provider: 'codex', model: 'gpt-5.6-luna', reasoning: null, onModelChange: vi.fn(), onReasoningChange: vi.fn() };
const catalog = { version: '0.137.0', source: 'live', models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', isDefault: true, defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium'] }] };
const reply = (data: unknown, ok = true) => Promise.resolve({ ok, json: async () => ok ? { ok, data } : { ok, error: data } });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((url: string) => url.includes('/update') ? reply({ managedUpdate: true, targetVersion: '0.153.4' }) : reply(catalog));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('preserves the selected model while discovering available choices', async () => {
  render(<CliModelPicker {...props} />);
  await screen.findByRole('option', { name: 'GPT-5.6 Luna' });
  expect(screen.getByLabelText('Model')).toHaveValue('gpt-5.6-luna');
  expect(screen.getByLabelText('Thinking effort')).toHaveValue('');
});

it('retains an unavailable saved model instead of substituting another', async () => {
  render(<CliModelPicker {...props} model="removed-model" />);
  await screen.findByText(/saved model is not in the current catalog/);
  expect(screen.getByLabelText('Model')).toHaveValue('removed-model');
  expect(screen.getByRole('button', { name: 'Test selection' })).toBeDisabled();
});

it('requires confirmation before updating and rechecks the resulting version', async () => {
  fetchMock.mockImplementation((url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return reply({ provider: 'codex', version: '0.153.4', changed: true });
    return url.includes('/update') ? reply({ managedUpdate: true, targetVersion: '0.153.4' }) : reply(catalog);
  });
  render(<CliModelPicker {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update CLI to 0.153.4' }));
  expect(screen.getByText(/Authentication and saved settings are preserved/)).toBeVisible();
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Install update' }));
  await screen.findByText(/CLI 0.153.4 installed/);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('refresh=true'))).toBe(true));
});

it('offers an update when outdated CLI model discovery fails', async () => {
  fetchMock.mockImplementation((url: string) => url.includes('/update') ? reply({ managedUpdate: true, targetVersion: '0.153.4' }) : reply('CLI requires an update', false));
  render(<CliModelPicker {...props} />);
  await screen.findByRole('alert');
  expect(await screen.findByRole('button', { name: 'Update CLI to 0.153.4' })).toBeEnabled();
});

it('provides an exact administrator command for unmanaged installations', async () => {
  fetchMock.mockImplementation((url: string) => url.includes('/update') ? reply({ managedUpdate: false, targetVersion: '0.153.4' }) : reply(catalog));
  render(<CliModelPicker {...props} />);
  await screen.findByText('npm install -g @openai/codex@0.153.4');
  expect(screen.queryByRole('button', { name: 'Update CLI to 0.153.4' })).not.toBeInTheDocument();
});
