import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { prisma } from '../apps/web/src/lib/prisma';

// Run against a disposable database and local production build:
// npx tsx --tsconfig apps/web/tsconfig.json scripts/flight-chart-browser-test.ts

interface PlotState extends HTMLElement {
  data: Array<{ y?: number[]; name?: string }>;
}

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? 'http://invalid');
  assert.equal(database.host, '127.0.0.1:55416');
  assert.equal(database.pathname, '/flight_test');
  const origin = process.env.FLIGHT_CHART_BROWSER_URL ?? 'http://127.0.0.1:3396';
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const query = await prisma.query.create({ data: {
    rawInput: 'chart bundle browser regression', origin: 'YUL', originName: 'Montreal', destination: 'NRT', destinationName: 'Tokyo',
    dateFrom: new Date('2027-04-15'), dateTo: new Date('2027-04-30'), expiresAt: new Date('2027-05-01'), currency: 'CAD', maxPrice: 2000, active: false,
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    await prisma.priceSnapshot.createMany({ data: [
      { queryId: query.id, travelDate: query.dateFrom, airline: 'Air Canada + Air Canada (approx OW+OW)', price: 999, currency: 'CAD', scrapedAt: new Date('2026-09-01') },
      { queryId: query.id, travelDate: query.dateFrom, airline: 'Air Canada', price: 2300, currency: 'CAD', scrapedAt: new Date('2026-09-02') },
      { queryId: query.id, travelDate: query.dateFrom, airline: 'Air Canada', price: 1809, currency: 'CAD', bookingUrl: 'https://example.com/flight-booking', scrapedAt: new Date('2026-09-03') },
      { queryId: query.id, travelDate: query.dateFrom, airline: 'ANA', price: 1750, currency: 'CAD', vpnCountry: 'CA', scrapedAt: new Date('2026-09-04') },
    ] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.route('https://example.com/flight-booking', route => route.fulfill({ body: 'Booking destination' }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/q/${query.id}`);
    const plot = page.locator('.js-plotly-plot').first();
    await page.waitForFunction(() => (document.querySelector('.js-plotly-plot') as PlotState | null)?.data?.length);
    const values = () => plot.evaluate(element => (element as PlotState).data.flatMap(trace => trace.y ?? []));
    assert.deepEqual((await values()).sort((a, b) => a - b), [1750, 1809]);

    const airlineTrace = await plot.evaluate(element => (element as PlotState).data.findIndex(trace => trace.name?.startsWith('Air Canada')));
    assert.ok(airlineTrace >= 0);
    const point = plot.locator('.scatterlayer .trace').nth(airlineTrace).locator('.points .point').first();
    await point.scrollIntoViewIfNeeded();
    const box = await point.boundingBox();
    assert.ok(box);
    // Plotly's drag overlay receives real pointer events above the SVG marks.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('.hoverlayer')?.textContent?.includes('Air Canada'));
    const popup = page.waitForEvent('popup');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const booking = await popup;
    await booking.waitForURL('https://example.com/flight-booking');
    await booking.close();
    console.log('PASS real scatter rendering, hover details, and booking click');

    await page.getByRole('button', { name: 'All history', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('.js-plotly-plot') as PlotState | null)?.data.some(trace => trace.y?.includes(2300)));
    assert.deepEqual((await values()).sort((a, b) => a - b), [1750, 1809, 2300]);
    assert.ok(!(await page.locator('body').innerText()).includes('approx OW+OW'));
    await page.getByRole('button', { name: 'Current filters', exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector('.js-plotly-plot') as PlotState | null)?.data.some(trace => trace.y?.includes(2300)));
    console.log('PASS history switching preserves actual fares and excludes legacy estimates');

    const selector = page.locator('select').filter({ has: page.locator('option[value="comparison"]') });
    await selector.selectOption('comparison');
    await page.waitForFunction(() => (document.querySelector('.js-plotly-plot') as PlotState | null)?.data.some(trace => trace.name === 'Local'));
    assert.deepEqual((await values()).sort((a, b) => a - b), [1750, 1809]);
    await selector.selectOption('local');
    await page.waitForFunction(() => (document.querySelector('.js-plotly-plot') as PlotState | null)?.data.flatMap(trace => trace.y ?? []).length === 1);
    assert.deepEqual(await values(), [1809]);
    console.log('PASS VPN comparison and local-only filtering');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => (document.querySelector('.js-plotly-plot')?.getBoundingClientRect().width ?? 1000) < 390);
    assert.deepEqual(await values(), [1809]);
    assert.deepEqual(errors, []);
    console.log('PASS mobile resize without chart errors');
  } finally {
    await browser.close();
    await prisma.query.delete({ where: { id: query.id } });
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
