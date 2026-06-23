import puppeteer from 'puppeteer';
import { BaseScraper, type RunResult, type ScrapedVenue } from './base.js';
import { saveVenues } from './save.js';

const SOURCE_URL = 'https://www.google.com/maps';
const SEARCH_QUERIES = [
  'event venues in Cagayan de Oro',
  'function halls in Cagayan de Oro',
  'convention centers in Cagayan de Oro',
  'hotels Cagayan de Oro',
];

export class GoogleMapsScraper extends BaseScraper {
  readonly source = 'google_maps';

  async run(): Promise<RunResult> {
    const { getListPageVenues } = await import('../scraper/listPage.js') as unknown as { getListPageVenues: (page: unknown, scrolls: number) => Promise<Array<{ name?: string; address?: string; category?: string; rating?: number; placeId?: string; placeUrl?: string }>> };
    const { getDetailData } = await import('../scraper/detailPage.js') as unknown as { getDetailData: (page: unknown) => Promise<{ name?: string; address?: string; city?: string; website?: string; lat?: number; lng?: number }> };

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const venues: ScrapedVenue[] = [];
    const seenPlaceIds = new Set<string>();

    try {
      const page = await browser.newPage();
      await (page as unknown as { setUserAgent(s: string): Promise<void> }).setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

      for (const query of SEARCH_QUERIES) {
        console.log(`google_maps: searching "${query}"`);
        try {
          const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
          await (page as unknown as { goto(url: string, opts: unknown): Promise<unknown> }).goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
          const cards = await getListPageVenues(page, 6);
          console.log(`google_maps: ${cards.length} cards from "${query}"`);

          for (const card of cards) {
            if (!card.placeUrl || (card.placeId && seenPlaceIds.has(card.placeId))) continue;
            if (card.placeId) seenPlaceIds.add(card.placeId);
            try {
              await (page as unknown as { goto(url: string, opts: unknown): Promise<unknown> }).goto(card.placeUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
              const detail = await getDetailData(page);
              const venue: ScrapedVenue = {
                name: detail.name || card.name || '',
                address: detail.address || card.address || '',
                city: detail.city || 'Cagayan de Oro',
                country: 'Philippines',
                website: detail.website || '',
                latitude: detail.lat ?? null,
                longitude: detail.lng ?? null,
                sourceUrl: card.placeUrl,
                placeId: card.placeId || '',
                primaryType: card.category || '',
                rating: card.rating ?? null,
              };
              if (venue.name) venues.push(venue);
            } catch (err) {
              console.error(`google_maps: detail failed ${card.placeUrl}:`, err instanceof Error ? err.message : String(err));
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
