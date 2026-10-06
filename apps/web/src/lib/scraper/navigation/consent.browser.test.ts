import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errors, type Browser } from 'playwright';
import { launchBrowser } from '../browser';
import { TravelExecution, withTravelExecution } from '../../travel/execution';
import { dismissGoogleConsent } from './consent';

describe.skipIf(process.env.TRAVEL_BROWSER_TESTS !== '1')('Google consent in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  it.each(['Accept all', 'Tout accepter', 'Alles akzeptieren', 'Alle akzeptieren', 'Aceptar todo', 'Aceptar todos', 'Accetta tutto'])('accepts a visible localized consent action: %s', async label => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<button onclick="document.body.dataset.accepted='yes'">${label}</button>`);
      expect(await dismissGoogleConsent(page)).toBe(true);
      expect(await page.getAttribute('body', 'data-accepted')).toBe('yes');
    } finally { await page.close(); }
  });
  it('waits for delayed consent and ignores an earlier hidden duplicate', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button hidden>Accept all</button><button id="visible" hidden onclick="document.body.dataset.accepted=\'yes\'">Accept all</button><script>setTimeout(()=>document.getElementById("visible").hidden=false,150)</script>');
      expect(await dismissGoogleConsent(page)).toBe(true);
      expect(await page.getAttribute('body', 'data-accepted')).toBe('yes');
    } finally { await page.close(); }
  });
  it.each(['I agree', 'Agree', 'Accept', 'Continue', 'Got it'])('restricts %s to the cookie dialog beside a booking dialog', async label => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div role="dialog" aria-label="Book your flight"><button onclick="document.body.dataset.booked='yes'">${label}</button></div><div role="dialog" aria-labelledby="consent-heading"><h2 id="consent-heading">Cookie consent</h2><button onclick="document.body.dataset.accepted='yes'">${label}</button></div>`);
      expect(await dismissGoogleConsent(page)).toBe(true);
      expect(await page.getAttribute('body', 'data-accepted')).toBe('yes');
      expect(await page.getAttribute('body', 'data-booked')).toBeNull();
    } finally { await page.close(); }
  });
  it('leaves booking actions untouched when consent is absent', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<h1>Cookie information</h1><div role="dialog" aria-label="Book your flight"><button onclick="document.body.dataset.booked=\'yes\'">Continue</button></div><button>Accept all flights</button>');
      expect(await dismissGoogleConsent(page)).toBe(false);
      expect(await page.getAttribute('body', 'data-booked')).toBeNull();
    } finally { await page.close(); }
  });
  it('surfaces a consent click timeout rather than treating it as absent consent', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button disabled>Accept all</button>');
      await expect(dismissGoogleConsent(page)).rejects.toBeInstanceOf(errors.TimeoutError);
    } finally { await page.close(); }
  });
  it('surfaces a closed page rather than treating it as absent consent', async () => {
    const page = await browser.newPage();
    await page.close();
    await expect(dismissGoogleConsent(page)).rejects.toThrow(/closed/i);
  });
  it('cancels an in-flight consent wait and settles the tracked browser', async () => {
    const execution = new TravelExecution({ jobId: 'consent-fixture', generation: 1, resource: 'direct' });
    let owned: Browser | undefined;
    await expect(withTravelExecution(execution, async () => {
      owned = await launchBrowser();
      const page = await owned.newPage();
      await page.setContent('<h1>Waiting for consent</h1>');
      const timer = setTimeout(() => execution.abort(new Error('Consent fixture cancelled')), 100);
      try { await dismissGoogleConsent(page); } finally { clearTimeout(timer); }
    })).rejects.toThrow(/Consent fixture cancelled/);
    expect(owned?.isConnected()).toBe(false);
  });
});
