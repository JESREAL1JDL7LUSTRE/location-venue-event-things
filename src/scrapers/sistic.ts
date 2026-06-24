import got from 'got';
import { BaseScraper, type RunResult, type ScrapedEvent } from './base.js';
import { saveEvents } from './save.js';

const SITE = 'https://www.sistic.com.sg';
const SEARCH_API = `${SITE}/sistic/docroot/api/get-solr-search-results`;
const SOURCE_URL = `${SITE}/events`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)', Accept: 'application/json' };
const PAGE_SIZE = 100;
const CLIENT = '1';

interface SisticItem {
  nid: number;
  alias?: string;
  title?: string;
  venue?: string;
  genre?: string;
  synopsis?: string;
  event_date?: string;
  horizontal_image?: string;
  min_price?: number | string;
  currency?: string;
}

const parseSisticDate = (dateStr: string): Date | null => {
  if (!dateStr) return null;
  // Format varies: "Fri,25 September 2026, 7.30pm" or "Fri, 14 Aug 2026 - Sun, 30 Aug 2026"
  // Try to extract the first date
  const clean = dateStr.replace(/ /g, ' ').trim();
  const m = clean.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  try {
    const d = new Date(`${m[1]} ${m[2]} ${m[3]}`);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
};

const fetchAllEvents = async (): Promise<SisticItem[]> => {
  const items: SisticItem[] = [];
  let first = 0;
  while (true) {
    try {
      const resp = await got(SEARCH_API, {
        headers: HEADERS,
        searchParams: { client: CLIENT, first, limit: PAGE_SIZE, search: '*' },
        timeout: { request: 30_000 },
      }).json<{ data?: SisticItem[] }>();
      const data = resp.data ?? [];
      if (!data.length) break;
      items.push(...data);
      if (data.length < PAGE_SIZE) break;
      first += data.length;
    } catch (err) {
      console.error(`sistic: listing (first=${first}) failed:`, err);
      break;
    }
  }
  return items;
};

export class SisticScraper extends BaseScraper {
  readonly source = 'sistic';

  async run(): Promise<RunResult> {
    const listings = await fetchAllEvents();
    console.log(`sistic: ${listings.length} listings`);

    const events: ScrapedEvent[] = [];

    for (const item of listings) {
      const name = (item.title ?? '').trim();
      if (!name) continue;

      const alias = (item.alias ?? '').trim();
      const eventUrl = alias ? `${SITE}/events/${alias}` : SOURCE_URL;

      const minPrice = item.min_price !== undefined ? parseFloat(String(item.min_price)) : null;
      const priceStr = minPrice === null || isNaN(minPrice)
        ? ''
        : minPrice === 0 ? 'Free' : `S$${minPrice.toLocaleString('en')}`;

      events.push({
        name,
        description: (item.synopsis ?? '').replace(/<[^>]+>/g, '').trim(),
        startsAt: parseSisticDate(item.event_date ?? ''),
        endsAt: null,
        url: eventUrl,
        imageUrl: item.horizontal_image ?? '',
        price: priceStr,
        category: item.genre ?? '',
        externalId: String(item.nid),
        sourceUrl: SOURCE_URL,
        organizer: '',
        organizerUrl: '',
        venue: item.venue
          ? { name: item.venue, city: 'Singapore', country: 'SG', sourceUrl: eventUrl }
          : null,
      });
    }

    console.log(`sistic: ${events.length} events`);
    return saveEvents(this.source, events);
  }
}
