import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import pg from 'pg';
import { admitBrowserHousehold, addBrowserSession } from '../access-browser-test.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:3408';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.ok([new URL(origin), database].every(url => ['127.0.0.1', 'localhost'].includes(url.hostname)), 'Use a disposable local instance/database');
assert.ok(database.port && database.pathname === '/flight_forks', 'Use the explicitly ported disposable flight_forks database');
assert.ok(process.env.TEST_ACCESS_NAME && process.env.TEST_ACCESS_PASSWORD, 'Provide an initialized disposable administrator');
const token = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `ft-session=${token}` };
const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: process.env.TEST_ACCESS_NAME }) });
assert.equal(login.status, 200, await login.text());
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York', viewport: { width: 1440, height: 1100 } });
context.setDefaultTimeout(15000);
await addBrowserSession(context, origin, token);
await context.route('https://booking.example/**', route => route.fulfill({ body: 'Disposable booking destination' }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('console', message => { if (/hydration|did not match|server rendered|minified react/i.test(message.text())) errors.push(message.text()); });
const ids = [randomUUID(), randomUUID()];
const groupId = randomUUID();
const instants = ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'];
const plot = page.locator('.js-plotly-plot').first();

async function waitForCharts() {
  await page.waitForFunction(() => {
    const charts = [...document.querySelectorAll('.js-plotly-plot')];
    return charts.length === 2 && charts.every(chart => chart.data?.length);
  });
}

async function chartState() {
  return plot.evaluate(chart => ({ data: chart.data, ticks: chart.layout.xaxis.ticktext, range: chart.layout.xaxis.range }));
}

async function waitForVisibility(key, hidden) {
  await page.waitForFunction(({ key, hidden }) => {
    const chart = document.querySelector('.js-plotly-plot');
    const traces = chart?.data?.filter(trace => trace.meta === key);
    return traces?.length && traces.every(trace => {
      const markers = chart.querySelectorAll(`.scatterlayer .trace${trace.uid} .point`).length;
      return (trace.visible === 'legendonly') === hidden && (hidden ? markers === 0 : markers > 0);
    });
  }, { key, hidden });
}

try {
  const config = (await pool.query('SELECT enabled,"setupComplete" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0];
  assert.equal(config?.enabled, false, 'Disable scheduling before adding test trackers');
  assert.equal(config?.setupComplete, true, 'Complete setup through the API before testing charts');
  const owner = (await pool.query('SELECT id FROM "User" WHERE username=$1', [process.env.TEST_ACCESS_NAME])).rows[0];
  assert.ok(owner);
  for (let index = 0; index < ids.length; index++) {
    const date = `2027-06-${15 + index}`;
    await pool.query('INSERT INTO "Query" (id,"rawInput",origin,"originName",destination,"destinationName","dateFrom","dateTo","expiresAt","groupId","userId","updatedAt","tripType",active) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,now(),$11,false)',
      [ids[index], 'Flight view browser acceptance', 'JFK', 'New York', 'LAX', 'Los Angeles', date, '2027-06-20', groupId, owner.id, 'one_way']);
    const rows = [
      ['DL101', '6:40 AM', 100, 0], ['DL101', '6:40 AM', 120, 1],
      ['DL102', '6:40 PM', 200, 0], ['DL102', '6:40 PM', 220, 1],
      [null, '6:40 AM', 150, 1], [null, '6:40 PM', 250, 1],
      [null, null, 300, 1], [null, null, 310, 1],
      ['DL101', '6:40 AM', 80, 1, 'CA'], ['DL101', '6:40 AM', 60, 1, null, 'EUR'],
      ['DL999', '10:00', 99, 1, null, 'USD', 'sold_out'],
    ];
    for (const [number, clock, price, instant, vpn = null, currency = 'USD', status = 'available'] of rows) {
      const identity = `Delta-${number ?? (clock ? '640' : '0000')}-JFK-LAX-${date}`;
      await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,stops,duration,"flightId","flightNumber","departureTime","arrivalTime","scrapedAt","bookingUrl",status,"vpnCountry") VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
        [randomUUID(), ids[index], date, price, currency, 'Delta', '2h', identity, number, clock, clock ? '09:00' : null, instants[instant], `https://booking.example/${number ?? 'unknown'}`, status, vpn]);
    }
  }
  const stored = (await pool.query('SELECT count(*)::int AS count FROM "PriceSnapshot" WHERE "queryId"=ANY($1::text[])', [ids])).rows[0].count;
  const beforeOrigin = process.env.CHART_BEFORE_ORIGIN;
  if (beforeOrigin) {
    assert.ok(['127.0.0.1', 'localhost'].includes(new URL(beforeOrigin).hostname));
    const beforeContext = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York', viewport: { width: 1440, height: 1100 } });
    await addBrowserSession(beforeContext, beforeOrigin, token);
    const beforePage = await beforeContext.newPage();
    await beforePage.goto(`${beforeOrigin}/q/${ids[0]}`);
    await beforePage.waitForFunction(() => document.querySelector('.js-plotly-plot')?.data?.length);
    assert.equal(await beforePage.getByRole('combobox', { name: 'Group by' }).count(), 0);
    await beforePage.screenshot({ path: '/tmp/flight-chart-before.png', fullPage: true });
    await beforeContext.close();
  }
  await page.goto(`${origin}/q/${ids[0]}`);
  await waitForCharts();
  const grouping = page.getByRole('combobox', { name: 'Group by', exact: true }).first();
  assert.equal(await grouping.inputValue(), 'airline', 'Existing carrier grouping is the default');
  await grouping.focus();
  await grouping.press('f');
  await grouping.press('Tab');
  assert.equal(await grouping.inputValue(), 'flight', 'Keyboard selection must choose the explicit flight view');
  await page.waitForFunction(() => document.querySelector('.js-plotly-plot')?.data?.every(trace => typeof trace.meta === 'string'));
  await page.waitForFunction(() => document.querySelector('.js-plotly-plot')?.querySelectorAll('.legendtext').length === 9);
  const initial = await chartState();
  assert.equal(initial.data.length, 9, JSON.stringify(initial.data.map(trace => ({ name: trace.name, y: trace.y }))));
  assert.equal(initial.data.filter(trace => trace.name.includes('2027-06-15')).length, 9);
  assert.equal(initial.data.filter(trace => String(trace.meta).includes('observation:')).length, 2, 'Unknown legacy-id observations remain separate');
  const legacy = initial.data.filter(trace => trace.meta?.includes('Delta-640-'));
  assert.equal(legacy.length, 2, 'AM and PM departures with colliding legacy ids remain separate');
  const direct = initial.data.find(trace => trace.name.includes('DL101') && trace.name.includes('(USD) (Local)'));
  assert.deepEqual(direct.x, instants);
  assert.deepEqual(direct.y, [100, 120]);
  assert.ok(initial.ticks.some(label => label.includes('GMT-4')) && initial.ticks.some(label => label.includes('GMT-5')));
  const renderedTicks = await plot.locator('.xtick').allTextContents();
  assert.ok(renderedTicks.some(label => label.includes('GMT-4')) && renderedTicks.some(label => label.includes('GMT-5')), JSON.stringify(renderedTicks));
  const visibleErrors = page.getByRole('alert').filter({ hasText: /\S/ });
  assert.equal(await visibleErrors.count(), 0, JSON.stringify(await visibleErrors.allTextContents()));
  console.log('PASS flight opt-in, independent identities and DST chronology');

  await plot.scrollIntoViewIfNeeded();
  await plot.evaluate(chart => chart.on('plotly_relayout', event => { chart.dataset.testRelayout = JSON.stringify(event); }));
  const drag = await plot.locator('.nsewdrag').boundingBox();
  assert.ok(drag);
  await page.mouse.move(drag.x + drag.width * 0.2, drag.y + drag.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(drag.x + drag.width * 0.8, drag.y + drag.height * 0.8, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.js-plotly-plot')?.dataset.testRelayout);
  await page.waitForFunction(previous => JSON.stringify(document.querySelector('.js-plotly-plot')?.layout.xaxis.range) !== previous, JSON.stringify(initial.range));
  const zoomed = (await chartState()).range;
  await plot.locator('.legend .traces').filter({ hasText: direct.name }).locator('.legendtoggle').click();
  await waitForVisibility(direct.meta, true);
  assert.deepEqual((await chartState()).range, zoomed, 'Legend choices preserve the current zoom');
  console.log('PASS real legend click and retained zoom');
  const usdChoices = page.getByRole('checkbox', { name: /Show Delta DL101 .*USD/ });
  assert.equal(await usdChoices.count(), 2, 'Visibility controls exist for direct and VPN observations');
  for (const checkbox of await usdChoices.all()) assert.equal(await checkbox.isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: /Show Delta DL101 .*EUR/ }).isChecked(), true);
  assert.equal(await page.getByRole('combobox', { name: 'Group by' }).nth(1).inputValue(), 'airline', 'Sibling trackers keep independent preferences');
  await page.reload();
  await waitForCharts();
  assert.equal(await grouping.inputValue(), 'flight');
  await waitForVisibility(direct.meta, true);
  await page.getByRole('button', { name: 'Show all flights', exact: true }).click();
  await waitForVisibility(direct.meta, false);

  for (const checkbox of await page.getByRole('checkbox', { name: /^Show Delta/ }).all()) await checkbox.uncheck();
  await page.waitForFunction(() => {
    const chart = document.querySelector('.js-plotly-plot');
    return chart?.data?.every(trace => trace.visible === 'legendonly') && chart.querySelectorAll('.scatterlayer .point').length === 0;
  });
  assert.equal(await page.getByRole('checkbox', { name: /^Show Delta/ }).count(), 9, 'Hidden flights keep their restore controls');
  await page.getByRole('button', { name: 'Show all flights', exact: true }).click();
  await waitForVisibility(direct.meta, false);
  await page.screenshot({ path: '/tmp/flight-chart-desktop.png', fullPage: true });

  const countries = page.getByRole('combobox', { name: 'Country view', exact: true }).first();
  await countries.selectOption('comparison');
  await page.waitForFunction(() => document.querySelector('.js-plotly-plot')?.data?.some(trace => trace.name === 'Local (EUR)'));
  const comparison = (await chartState()).data;
  assert.deepEqual(comparison.find(trace => trace.name === 'Local (USD)').y, [100, 120]);
  assert.deepEqual(comparison.find(trace => trace.name === 'Local (EUR)').y, [60]);
  await usdChoices.first().uncheck();
  await page.waitForFunction(() => !document.querySelector('.js-plotly-plot')?.data?.some(trace => trace.name.includes('CA')));
  assert.deepEqual((await chartState()).data.find(trace => trace.name === 'Local (USD)').y, [200, 150]);
  await page.getByRole('button', { name: 'Show all flights', exact: true }).click();
  await countries.selectOption('all');
  await page.waitForFunction(() => {
    const chart = document.querySelector('.js-plotly-plot');
    return chart?.data?.length === 9 && chart.querySelectorAll('.legendtext').length === 9 && chart.querySelectorAll('.scatterlayer .trace').length === 9;
  });

  const traceIndex = (await chartState()).data.findIndex(trace => trace.name.includes('DL102'));
  const point = plot.locator('.scatterlayer .trace').nth(traceIndex).locator('.points .point').first();
  await point.scrollIntoViewIfNeeded();
  const box = await point.boundingBox();
  assert.ok(box);
  await plot.evaluate(chart => chart.on('plotly_click', event => { chart.dataset.testClick = JSON.stringify({ yvals: event.yvals, points: event.points.map(point => ({ curveNumber: point.curveNumber, y: point.y, customdata: point.customdata })) }); }));
  const popup = page.waitForEvent('popup');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const booking = await popup;
  await booking.waitForURL(/^https:\/\/booking\.example\//);
  assert.equal(booking.url(), 'https://booking.example/DL102', await plot.getAttribute('data-test-click'));
  await booking.close();
  assert.ok((await chartState()).data.filter(trace => trace.name.includes('Sold out')).every(trace => trace.customdata.every(value => value[0] === null)), 'Sold-out observations never supply booking targets');

  const filtered = await fetch(`${origin}/api/queries/${ids[0]}`, { method: 'PATCH', headers, body: JSON.stringify({ maxPrice: 200 }) });
  assert.equal(filtered.status, 200, await filtered.text());
  await page.reload();
  await waitForCharts();
  assert.ok((await chartState()).data.flatMap(trace => trace.y).every(price => price <= 200));
  await page.getByRole('button', { name: 'All history', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('.js-plotly-plot')?.data?.some(trace => trace.y.includes(310)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => (document.querySelector('.js-plotly-plot')?.getBoundingClientRect().width ?? 1000) < 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await grouping.inputValue(), 'flight');
  await page.screenshot({ path: '/tmp/flight-chart-mobile.png', fullPage: true });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM "PriceSnapshot" WHERE "queryId"=ANY($1::text[])', [ids])).rows[0].count, stored);
  assert.deepEqual(errors, [], 'Browser runtime and hydration errors');
  console.log('Chart/browser/PostgreSQL acceptance passed: keyboard opt-in, flight series, unknown and legacy identities, DST chronology and local offsets, real legend clicks, zoom, synchronized history, reload persistence, tracker isolation, hide-all recovery, currencies, VPN comparison, booking, criteria history, mobile and hydration.');
} finally {
  await pool.query('DELETE FROM "Query" WHERE id=ANY($1::text[])', [ids]);
  await context.close();
  await browser.close();
  await pool.end();
}
