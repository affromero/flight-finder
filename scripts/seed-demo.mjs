#!/usr/bin/env node
// Seed realistic demo data for screenshots.
// Run: doppler run --project flight-finder --config prd -- node scripts/seed-demo.mjs
// Clean: doppler run --project flight-finder --config prd -- node scripts/seed-demo.mjs --clean

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ROUTES = [
  {
    rawInput: 'NYC to Paris in July',
    origin: 'JFK', originName: 'New York',
    destination: 'CDG', destinationName: 'Paris',
    dateFrom: '2026-07-10', dateTo: '2026-07-20',
    airlines: ['Air France', 'Delta', 'United', 'Norse Atlantic'],
    basePrices: [620, 580, 640, 420],
  },
  {
    rawInput: 'LA to Tokyo next month',
    origin: 'LAX', originName: 'Los Angeles',
    destination: 'NRT', destinationName: 'Tokyo',
    dateFrom: '2026-04-05', dateTo: '2026-04-15',
    airlines: ['ANA', 'Japan Airlines', 'United', 'Singapore Airlines'],
    basePrices: [890, 920, 780, 1050],
  },
  {
    rawInput: 'Chicago to Rome in June',
    origin: 'ORD', originName: 'Chicago',
    destination: 'FCO', destinationName: 'Rome',
    dateFrom: '2026-06-01', dateTo: '2026-06-12',
    airlines: ['ITA Airways', 'Lufthansa', 'American', 'Swiss'],
    basePrices: [550, 610, 570, 680],
  },
];

// Generate realistic price fluctuations over 14 days of scraping
function generatePrices(basePrice, scrapeCount) {
  const prices = [];
  let current = basePrice;
  for (let i = 0; i < scrapeCount; i++) {
    // Random walk with slight upward bias (airlines raise prices over time)
    const change = (Math.random() - 0.45) * basePrice * 0.06;
    current = Math.max(basePrice * 0.75, Math.min(basePrice * 1.4, current + change));
    prices.push(Math.round(current * 100) / 100);
  }
  return prices;
}

async function seed() {
  console.log('Seeding demo data...');

  const now = new Date();
  const queryIds = [];

  for (const route of ROUTES) {
    // Create query
    const query = await prisma.query.create({
      data: {
        rawInput: route.rawInput,
        origin: route.origin,
        originName: route.originName,
        destination: route.destination,
        destinationName: route.destinationName,
        dateFrom: new Date(route.dateFrom),
        dateTo: new Date(route.dateTo),
        flexibility: 3,
        cabinClass: 'economy',
        tripType: 'round_trip',
        currency: 'USD',
        active: true,
        isSeed: true,
        expiresAt: new Date(new Date(route.dateTo).getTime() + 3 * 86400000),
      },
    });
    queryIds.push(query.id);
    console.log(`  Created query: ${route.origin} → ${route.destination} (${query.id})`);

    // Generate 14 days of scrapes, 3x per day (every 8h)
    const scrapeCount = 42;
    const travelDates = [];
    const from = new Date(route.dateFrom);
    const to = new Date(route.dateTo);
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      travelDates.push(new Date(d));
    }

    for (let s = 0; s < scrapeCount; s++) {
      const scrapeTime = new Date(now.getTime() - (scrapeCount - s) * 8 * 3600000);

      const fetchRun = await prisma.fetchRun.create({
        data: {
          queryId: query.id,
          status: 'success',
          source: 'google_flights',
          snapshotsCount: route.airlines.length * travelDates.length,
          startedAt: scrapeTime,
          completedAt: new Date(scrapeTime.getTime() + 15000),
        },
      });

      const snapshots = [];
      for (let a = 0; a < route.airlines.length; a++) {
        const priceSeries = generatePrices(route.basePrices[a], travelDates.length);
        // Add time-based drift: prices vary per scrape run
        const runDrift = (Math.random() - 0.45) * route.basePrices[a] * 0.03;

        for (let d = 0; d < travelDates.length; d++) {
          const price = Math.max(99, priceSeries[d] + runDrift + (s * route.basePrices[a] * 0.004));
          snapshots.push({
            queryId: query.id,
            fetchRunId: fetchRun.id,
            travelDate: travelDates[d],
            price: Math.round(price * 100) / 100,
            currency: 'USD',
            airline: route.airlines[a],
            bookingUrl: `https://www.google.com/travel/flights?q=${route.origin}+to+${route.destination}`,
            stops: Math.random() > 0.7 ? 1 : 0,
            duration: `${7 + Math.floor(Math.random() * 6)}h ${Math.floor(Math.random() * 50) + 10}m`,
            flightId: `${route.airlines[a].replace(/\s/g, '')}-${1000 + a * 100 + d}-${route.origin}-${route.destination}`,
            status: 'available',
            scrapedAt: scrapeTime,
          });
        }
      }

      await prisma.priceSnapshot.createMany({ data: snapshots });
    }

    console.log(`  Created ${scrapeCount} scrape runs with price data`);
  }

  console.log('\nDemo queries:');
  for (const id of queryIds) {
    console.log(`  https://flight-finder.org/q/${id}`);
  }
  console.log('\nDone! Use --clean to remove seed data.');
}

async function clean() {
  console.log('Cleaning seed data...');
  const queries = await prisma.query.findMany({ where: { isSeed: true }, select: { id: true } });
  for (const q of queries) {
    await prisma.priceSnapshot.deleteMany({ where: { queryId: q.id } });
    await prisma.fetchRun.deleteMany({ where: { queryId: q.id } });
  }
  const result = await prisma.query.deleteMany({ where: { isSeed: true } });
  console.log(`Deleted ${result.count} seed queries and all their data.`);
}

try {
  if (process.argv.includes('--clean')) {
    await clean();
  } else {
    await seed();
  }
} finally {
  await prisma.$disconnect();
}
