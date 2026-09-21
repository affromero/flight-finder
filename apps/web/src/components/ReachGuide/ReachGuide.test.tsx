/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../../messages/en/components.json';
import es from '../../../messages/es/components.json';
import fr from '../../../messages/fr/components.json';
import de from '../../../messages/de/components.json';
import pt from '../../../messages/pt/components.json';
import { ReachGuide } from './ReachGuide';

vi.unmock('next-intl');

function renderGuide(locale = 'en', messages = en) {
  render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC" onError={error => { throw error; }}><ReachGuide /></NextIntlClientProvider>);
}

afterEach(cleanup);

describe('ReachGuide', () => {
  it('defaults to Tailscale and shows its steps', () => {
    renderGuide();
    expect(screen.getByText(/tailscale up/)).toBeTruthy();
  });

  it('Cloudflare offers real permanent named-tunnel steps, not a vague note', () => {
    renderGuide();
    fireEvent.click(screen.getByRole('tab', { name: /Cloudflare/ }));
    expect(screen.getByText(/cloudflared tunnel login/)).toBeTruthy();
    expect(screen.getByText(/route dns/)).toBeTruthy();
  });

  it('on localhost, Same Wi-Fi explains how to find the network IP', () => {
    renderGuide();
    fireEvent.click(screen.getByRole('tab', { name: /Same Wi-Fi/ }));
    expect(screen.getByText(/network IP/)).toBeTruthy();
  });

  it('switching OS changes the install command', () => {
    renderGuide();
    fireEvent.click(screen.getByRole('tab', { name: /Cloudflare/ }));
    fireEvent.click(screen.getByRole('button', { name: 'macOS' }));
    expect(screen.getByText(/brew install cloudflared/)).toBeTruthy();
  });

  it.each(Object.entries({ en, es, fr, de, pt }))('renders tunnel guidance in %s without translation errors', (locale, messages) => {
    renderGuide(locale, messages);
    fireEvent.click(screen.getByRole('tab', { name: /Cloudflare/ }));
    expect(screen.getByText(/https:\/\/<name>\.trycloudflare\.com/)).toBeTruthy();
  });
});
