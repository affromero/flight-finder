/**
 * Capture demo-light.gif — seeds mock data, screenshots query page in light mode,
 * converts to GIF with ffmpeg, then cleans up.
 *
 * Usage: doppler run --project flight-finder --config dev -- npx tsx scripts/capture-demo-light.ts
 */

import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

const QUERY_ID = 'demo-light-capture';
const PORT = 3003;
const WIDTH = 1280;
const HEIGHT = 900;
const OUTPUT = 'apps/web/public/demo-light.gif';
const SCREENSHOT = '/tmp/demo-light-frame.png';

async function main() {
  const prisma = new PrismaClient();

  try {
    // Clean up any previous run
    await prisma.priceSnapshot.deleteMany({ where: { queryId: QUERY_ID } });
    await prisma.fetchRun.deleteMany({ where: { queryId: QUERY_ID } });
    await prisma.query.deleteMany({ where: { id: QUERY_ID } });

    // Seed mock query
    const now = new Date();
    const dateFrom = new Date('2026-07-10');
    const dateTo = new Date('2026-07-20');
    const expiresAt = new Date(now.getTime() + 137 * 24 * 60 * 60 * 1000);

    await prisma.query.create({
      data: {
        id: QUERY_ID,
        rawInput: 'JFK to Paris mid July under $800',
        origin: 'JFK',
        originName: 'New York',
        destination: 'CDG',
        destinationName: 'Paris',
        dateFrom,
        dateTo,
        flexibility: 3,
        expiresAt,
        firstViewedAt: now,
      },
    });

    // Seed mock price snapshots — 4 airlines over ~16 days
    const airlines = [
      { name: 'Air France', base: 620, variance: 50, stops: 0, duration: '8h 15m', url: 'https://www.airfrance.com' },
      { name: 'Delta', base: 650, variance: 60, stops: 0, duration: '8h 30m', url: 'https://www.delta.com' },
      { name: 'United', base: 580, variance: 45, stops: 1, duration: '11h 20m', url: 'https://www.united.com' },
      { name: 'Norse Atlantic', base: 420, variance: 40, stops: 0, duration: '9h 27m', url: 'https://www.flynorse.com' },
    ];

    const snapshots: Array<{
      queryId: string;
      travelDate: Date;
      price: number;
      currency: string;
      airline: string;
      bookingUrl: string;
      stops: number;
      duration: string;
      status: string;
      scrapedAt: Date;
    }> = [];

    // Generate data points every 8 hours for 16 days
    for (let day = 0; day < 16; day++) {
      for (let hour = 0; hour < 24; hour += 8) {
        const scrapedAt = new Date(now.getTime() - (16 - day) * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000);
        for (const airline of airlines) {
          const trend = day * 1.5; // slight upward trend
          const noise = (Math.random() - 0.5) * airline.variance;
          const price = Math.round((airline.base + trend + noise) * 100) / 100;
          snapshots.push({
            queryId: QUERY_ID,
            travelDate: dateFrom,
            price,
            currency: 'USD',
            airline: airline.name,
            bookingUrl: airline.url,
            stops: airline.stops,
            duration: airline.duration,
            status: 'ok',
            scrapedAt,
          });
        }
      }
    }

    await prisma.priceSnapshot.createMany({ data: snapshots });

    // Create a fetch run so "Last checked" shows
    await prisma.fetchRun.create({
      data: {
        queryId: QUERY_ID,
        status: 'completed',
        startedAt: new Date(now.getTime() - 30 * 60 * 1000),
        completedAt: now,
        snapshotsCount: snapshots.length,
      },
    });

    console.log(`Seeded ${snapshots.length} snapshots for query ${QUERY_ID}`);

    // Launch Playwright and capture screenshot
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
    });
    const page = await context.newPage();

    await page.goto(`http://localhost:${PORT}/q/${QUERY_ID}`, { waitUntil: 'networkidle' });

    // Set light theme
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('ft-theme', 'light');
    });

    // Wait for theme transition and chart to render
    await page.waitForTimeout(1000);

    // Wait for Plotly chart to be present
    await page.waitForSelector('.js-plotly-plot', { timeout: 5000 }).catch(() => {
      console.warn('No Plotly chart found, capturing anyway');
    });

    await page.screenshot({ path: SCREENSHOT });
    console.log(`Screenshot saved to ${SCREENSHOT}`);

    await browser.close();

    // Convert PNG to high-quality GIF with ffmpeg palettegen
    const palette = '/tmp/demo-light-palette.png';
    execSync(`ffmpeg -y -i "${SCREENSHOT}" -vf "palettegen=max_colors=256:stats_mode=single" "${palette}"`, { stdio: 'inherit' });
    execSync(`ffmpeg -y -i "${SCREENSHOT}" -i "${palette}" -lavfi "paletteuse=dither=floyd_steinberg" "${OUTPUT}"`, { stdio: 'inherit' });
    try { unlinkSync(palette); } catch {}
    console.log(`GIF saved to ${OUTPUT}`);

    // Clean up temp file
    try { unlinkSync(SCREENSHOT); } catch {}

  } finally {
    // Clean up mock data
    await prisma.priceSnapshot.deleteMany({ where: { queryId: QUERY_ID } });
    await prisma.fetchRun.deleteMany({ where: { queryId: QUERY_ID } });
    await prisma.query.deleteMany({ where: { id: QUERY_ID } });
    await prisma.$disconnect();
    console.log('Mock data cleaned up');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
