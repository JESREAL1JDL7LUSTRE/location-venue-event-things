import got from 'got';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedVenue } from './base.js';
import { saveEvents } from './save.js';

const SITE = 'https://www.eventbee.com';
const SEARCH_URL = `${SITE}/v/search-events/`;
const SOURCE_URL = `${SITE}/events/search?country=PH`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)' };
const SEARCH_PARAMS = { country: 'PH', type: 'upcoming' };

const parseDt = (s: string | undefined): Date | null => {
  if (!s) return null;
  try { return new Date(s); } catch { return null; }
};

const priceStr = (event: Record<string, unknown>): string => {
  const minP = parseFloat(String(event.min_price || 0));
  const maxP = parseFloat(String(event.max_price || 0));
  if (minP === 0 && maxP === 0) return 'Free';
  if (maxP > 0 && maxP !== minP) return `₱${minP.toLocaleString('en')}-₱${maxP.toLocaleString('en')}`;
  return `₱${minP.toLocaleString('en')}`;
};

const extractCity = (location: string): string => {
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] ?? '' : parts[0] ?? '';
};

const parseEventCard = ($: cheerio.CheerioAPI, el: Element): ScrapedEvent | null => {
  const $el = $(el);
  const name = $el.find('[class*="title"], h3, h4').first().text().trim();
  if (!name) return null;
  const href = $el.find('a[href*="/event/"]').first().attr('href') ?? '';
  const url = href.startsWith('http') ? href : href ? `${SITE}${href}` : '';
  const externalIdMatch = url.match(/\/event\/(\d+)/);
  const externalId = externalIdMatch ? externalIdMatch[1] : '';
  const imageUrl = $el.find('img').first().attr('src') ?? '';
  const dateText = $el.find('[class*="date"], time').first().text().trim();
  const locationText = $el.find('[class*="location"], [class*="venue"]').first().text().trim();
  let venue: ScrapedVenue | null = null;
  if (locationText) {
    venue = { name: locationText, city: extractCity(locationText), country: 'Philippines', sourceUrl: SOURCE_URL };
  }
  return {
    name, url, imageUrl, externalId, sourceUrl: SOURCE_URL,
    startsAt: parseDt(dateText),
    venue,
  };
};

export class EventbeeScraper extends BaseScraper {
  readonly source = 'eventbee';

  async run(): Promise<RunResult> {
    const events: ScrapedEvent[] = [];
    const seenIds = new Set<string>();

    try {
      const html = await got(SEARCH_URL, {
        headers: HEADERS,
        searchParams: SEARCH_PARAMS,
        timeout: { request: 30_000 },
      }).text();
      const $ = cheerio.load(html);
      $('[class*="event-card"], [class*="event-item"], article').each((_, el) => {
        const ev = parseEventCard($, el);
        if (!ev || (ev.externalId && seenIds.has(ev.externalId))) return;
        if (ev.externalId) seenIds.add(ev.externalId);
        events.push(ev);
      });
    } catch (err) {
      console.error('eventbee: search failed:', err);
    }

    console.log(`eventbee: ${events.length} events`);
    return saveEvents(this.source, events);
  }
}
