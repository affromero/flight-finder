/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { LoginForm } from './LoginForm';

const PROFILES = {
  ok: true,
  data: {
    profiles: [
      { id: 'a', username: 'admin', displayName: null, avatar: 'paper-plane', isAdmin: true },
      { id: 'b', username: 'bob', displayName: 'Bob', avatar: 'globe', isAdmin: false },
    ],
  },
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/api/auth/profiles')) {
      return new Response(JSON.stringify(PROFILES), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/auth/login')) {
      return new Response(JSON.stringify({ ok: true, data: { user: { isAdmin: true } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LoginForm profile picker', () => {
  it('selects Admin on tap without another password', async () => {
    const fetchSpy = mockFetch();
    render(<LoginForm next={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /admin/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }));
    });
    const loginCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/api/auth/login'))!;
    const body = JSON.parse((loginCall[1] as RequestInit).body as string);
    expect(body).toEqual({ username: 'admin' });
  });

  it('selects a member profile on tap without another password', async () => {
    const fetchSpy = mockFetch();
    render(<LoginForm next={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Bob/i }));
    await waitFor(() => expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/auth/login'))).toBe(true));
    const loginCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/api/auth/login'))!;
    expect(JSON.parse((loginCall[1] as RequestInit).body as string)).toEqual({ username: 'bob' });
  });
});
