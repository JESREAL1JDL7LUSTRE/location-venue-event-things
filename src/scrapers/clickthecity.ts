import got from 'got';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedVenue } from './base.js';
import { saveEvents } from './save.js';

const API = 'https://www.clickthecity.com/api/events';
const SITE = 'https://www.clickthecity.com';
const SOURCE_URL = `${SITE}/events`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)', Accept: 'application/json' };

const parseDate = (s: string | undefined): Date | null => {
  if (!s) return null;
  try { return new Date(s); } catch { return null; }
};

const buildVenue = (event: Record<string, unknown>): ScrapedVenue | null => {
  const venueName = ((event.venue as string) ?? '').trim();
  if (!venueName) return null;
  const location = (event.location as Record<string, unknown>) ?? {};
  const address = (location.address as Record<string, unknown>) ?? {};
  return {
    name: ((location.name as string) || venueName).trim(),
    address: ((address.streetAddress as string) ?? '').trim(),
    city: ((address.addressLocality as string) ?? '').trim(),
    country: ((address.addressCountry as string) || 'Philippines').trim(),
    sourceUrl: (event.venueUrl as string) ?? SOURCE_URL,
  };
};

const buildEvent = (event: Record<string, unknown>): ScrapedEvent => {
  const slug = (event.slug as string) || String(event.id ?? '');
  const priceRaw = ((event.price as string) ?? '').trim();
  const currency = ((event.priceCurrency as string) ?? '').trim();
  const price = currency && priceRaw && !['free', 'tba'].includes(priceRaw.toLowerCase())
    ? `${priceRaw} ${currency}`.trim()
    : priceRaw;

  return {
    name: ((event.title as string) ?? '').trim(),
    description: ((event.description as string) ?? '').trim(),
    startsAt: parseDate(event.startDate as string),
    endsAt: parseDate(event.endDate as string),
    url: `${SITE}/events/${slug}`,
    imageUrl: ((event.imageUrl as string) ?? '').trim(),
    price,
    category: ((event.category as string) ?? '').trim(),
    externalId: slug,
    sourceUrl: SOURCE_URL,
    organizer: ((event.organizer as string) ?? '').trim(),
    venue: buildVenue(event),
  };
};

export class ClickTheCityScraper extends BaseScraper {
  readonly source = 'clickthecity';

  async run(): Promise<RunResult> {
    const resp = await got(API, { headers: HEADERS, searchParams: { limit: 1000 }, timeout: { request: 30_000 } }).json<{ data: Record<string, unknown>[] }>();
    const events: ScrapedEvent[] = [];
    for (const ev of resp.data ?? []) {
      try { events.push(buildEvent(ev)); } catch { /* skip */ }
    }
    console.log(`clickthecity: ${events.length} events`);
    return saveEvents(this.source, events);
  }
}
