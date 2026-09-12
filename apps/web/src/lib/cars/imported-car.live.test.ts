import { describe, expect, it } from 'vitest';
import { launchBrowser } from '../scraper/browser';
import { TravelExecution, withTravelExecution, closeTravelBrowser } from '../travel/execution';
import { createCarBrowserContext } from './browser-context';
import { navigateAutoEuropeSearch } from './autoeurope-navigation';
import { navigateDiscoverCarsSearch } from './discovercars-navigation';
import { validateCarSearch } from './validation';
import { searchCars } from './search';
import { validateCarReport } from './report';
import { carProtectionQuoteIdentity } from './protection-discovery';
import { resolveCarProviderLocations } from './location-resolution';
import { getCarCatalogPlace } from './locations';

describe.skipIf(process.env.TRAVEL_LIVE_TESTS !== '1')('selected quotes on live rental providers', () => {
  it.each(['autoeurope', 'discovercars'] as const)('preserves a selected %s quote and surfaces unverified terms', async source => {
    const place = await getCarCatalogPlace('ourairports:2434');
    const location = { name: place.name, country: place.country, timeZone: place.timeZone, providerIds: {}, catalog: { id: place.id, version: place.version } };
    const search = validateCarSearch({ pickup: location, dropoff: location, pickupAt: { date: '2026-10-15', time: '12:00' }, dropoffAt: { date: '2026-10-18', time: '12:00' }, driver: { age: 35, licenceYears: 5, residenceCountry: 'GB' }, currency: 'GBP', sources: [source] }, new Date(), { allowUnresolvedProviders: true });
    await withTravelExecution(new TravelExecution({ jobId: 'live-link-import', generation: 1, resource: 'browser' }), async () => {
      const browser = await launchBrowser();
      let sourceUrl: string | undefined;
      try {
        const context = await createCarBrowserContext(browser, search), page = await context.newPage();
        const resolved = await resolveCarProviderLocations(page, search, source);
        const discovery = source === 'autoeurope' ? await navigateAutoEuropeSearch(page, resolved) : await navigateDiscoverCarsSearch(page, resolved);
        sourceUrl = discovery.links[0];
      } finally { await closeTravelBrowser(browser); }
      if (!sourceUrl) throw new Error('The provider did not return a quote to import');
      const report = await searchCars({ ...search, sourceUrl });
      expect(report.errors).toEqual([]);
      const observations = [...report.offers, ...report.candidates];
      expect(observations).toHaveLength(1);
      expect(carProtectionQuoteIdentity(observations[0]!.bookingUrl, source)).toBe(carProtectionQuoteIdentity(sourceUrl, source));
      for (const candidate of report.candidates) {
        expect(report.offers).toHaveLength(0);
        expect(candidate.reasons.length).toBeGreaterThan(0);
        expect(candidate.advertisedTotal?.status ?? 'estimated').toBe('estimated');
      }
      expect(validateCarReport(report, [source])).toEqual(report);
    });
  }, 240000);
});
