import puppeteer from 'puppeteer';
import { BaseScraper, type RunResult, type ScrapedVenue } from './base.js';
import { saveVenues } from './save.js';
import { scrapeListPage } from '../scraper/listPage.js';
import { EXTRACTOR } from '../scraper/detailExtractor.js';

const SEARCH_QUERIES = [
  'event venues in Cagayan de Oro',
  'function halls in Cagayan de Oro',
  'convention centers in Cagayan de Oro',
  'hotels Cagayan de Oro',
];

const parseCoords = (url: string) => {
  const m = url.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
};

const parseCityFromAddress = (addr: string): string => {
  const parts = addr.split(',').map((p) => p.trim());
  const cdo = parts.find((p) => /cagayan/i.test(p));
  if (cdo) return cdo;
  return parts.length > 1 ? parts[parts.length - 2] ?? '' : parts[0] ?? '';
};

export class GoogleMapsScraper extends BaseScraper {
  readonly source = 'google_maps';

  async run(): Promise<RunResult> {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const venues: ScrapedVenue[] = [];
    const seenPlaceIds = new Set<string>();

    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

      for (const query of SEARCH_QUERIES) {
        console.log(`google_maps: searching "${query}"`);
        try {
          const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
          const cards = await scrapeListPage(page, searchUrl, 6);
          console.log(`google_maps: ${cards.length} cards from "${query}"`);

          for (const card of cards) {
            const placeUrl = card.url ?? null;
            if (!placeUrl) continue;

            const idMatch = placeUrl.match(/place\/[^/]+\/([^/?#]+)/);
            const placeId = idMatch ? idMatch[1] : placeUrl;

            if (seenPlaceIds.has(placeId)) continue;
            seenPlaceIds.add(placeId);

            try {
              await page.goto(placeUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
              const detail = await page.evaluate(EXTRACTOR) as unknown as Record<string, unknown>;
              const coords = parseCoords(page.url());
              const addr = (detail.fullAddress as string) || (card.location as Record<string, unknown>)?.address as string || '';

              const venue: ScrapedVenue = {
                name: card.name || '',
                address: addr,
                city: parseCityFromAddress(addr) || 'Cagayan de Oro',
                country: 'Philippines',
                website: (detail.website as string) || '',
                latitude: coords?.lat ?? null,
                longitude: coords?.lng ?? null,
                sourceUrl: placeUrl,
                placeId,
                primaryType: (card.location as Record<string, unknown>)?.category as string || '',
                rating: card.rating ?? null,
              };
              if (venue.name) venues.push(venue);
            } catch (err) {
              console.error(`google_maps: detail failed ${placeUrl}:`, err instanceof Error ? err.message : String(err));
            }
            await new Promise((r) => setTimeout(r, 1500));
          }
        } catch (err) {
          console.error(`google_maps: query failed "${query}":`, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      await browser.close();
    }

    console.log(`google_maps: ${venues.length} venues`);
    return saveVenues(this.source, venues);
  }
}
