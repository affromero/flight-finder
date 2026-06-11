/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ReachGuide } from './ReachGuide';

afterEach(cleanup);

describe('ReachGuide', () => {
  it('defaults to Tailscale and shows its steps', () => {
    render(<ReachGuide />);
    expect(screen.getByText(/tailscale up/)).toBeTruthy();
  });

  it('Cloudflare offers real permanent named-tunnel steps, not a vague note', () => {
    render(<ReachGuide />);
    fireEvent.click(screen.getByRole('tab', { name: /Cloudflare/ }));
    expect(screen.getByText(/cloudflared tunnel login/)).toBeTruthy();
    expect(screen.getByText(/route dns/)).toBeTruthy();
  });

  it('on localhost, Same Wi-Fi explains how to find the network IP', () => {
    render(<ReachGuide />);
    fireEvent.click(screen.getByRole('tab', { name: /Same Wi-Fi/ }));
    expect(screen.getByText(/network IP/)).toBeTruthy();
  });

  it('switching OS changes the install command', () => {
    render(<ReachGuide />);
    fireEvent.click(screen.getByRole('tab', { name: /Cloudflare/ }));
    fireEvent.click(screen.getByRole('button', { name: 'macOS' }));
    expect(screen.getByText(/brew install cloudflared/)).toBeTruthy();
  });
});
