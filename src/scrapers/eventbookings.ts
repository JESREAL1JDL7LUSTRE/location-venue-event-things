import got from 'got';
import * as cheerio from 'cheerio';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const EXPLORE_API = 'https://explore.eventbookings.com/api/explore-events';
const SITE = 'https://www.eventbookings.com';
const SOURCE_URL = `${SITE}/s/all-events?country=Philippines`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)', 'Content-Type': 'application/x-www-form-urlencoded' };
const PAGE_SIZE = 20;

const SCHEMA_EVENT_TYPES = new Set([
  'Event', 'TheaterEvent', 'MusicEvent', 'SportsEvent', 'BusinessEvent',
  'FoodEvent', 'Festival', 'SaleEvent', 'ChildrensEvent', 'ComedyEvent', 'EducationEvent',
]);

const parseDt = (s: string | undefined): Date | null => {
  if (!s) return null;
  try { return new Date(s); } catch { return null; }
};

const fetchListings = async (): Promise<Array<{ url: string; imageUrl: string }>> => {
  const items: Array<{ url: string; imageUrl: string }> = [];
  let position = 1;
  while (true) {
    try {
      const body = new URLSearchParams({
        action: 'load_more_events',
        current_country_code_trp: 'PH',
        ofst: String(position),
        // page size defaults to 20 on the server
      }).toString();
      const resp = await got.post(EXPLORE_API, {
        headers: HEADERS,
        body,
        timeout: { request: 25_000 },
      }).json<{ data?: Array<{ url?: string; image?: string }> }>();
      const data = resp.data ?? [];
      if (!data.length) break;
      for (const item of data) {
        if (item.url) items.push({ url: item.url, imageUrl: item.image ?? '' });
      }
      if (data.length < PAGE_SIZE) break;
      position += data.length;
    } catch (err) {
      console.error(`eventbookings: listing page (position=${position}) failed:`, err);
      break;
    }
  }
  return items;
};

const extractLdJson = (html: string): Record<string, unknown> | null => {
  const $ = cheerio.load(html);
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const text = $(el).text();
      const data = JSON.parse(text);
      const items: unknown[] = Array.isArray(data) ? data : (data['@graph'] as unknown[] ?? [data]);
      for (const item of items) {
        if (item && typeof item === 'object') {
          const t = (item as Record<string, unknown>)['@type'];
          const type = Array.isArray(t) ? t[0] : t;
          if (SCHEMA_EVENT_TYPES.has(String(type))) return item as Record<string, unknown>;
        }
      }
    } catch { /* skip */ }
  }
  return null;
};

const processListing = async (listing: { url: string; imageUrl: string }): Promise<{ ev: ScrapedEvent | null; org: ScrapedOrganizer | null }> => {
  try {
    const html = await got(listing.url, { headers: HEADERS, timeout: { request: 25_000 } }).text();
    const ld = extractLdJson(html);
    if (!ld) return { ev: null, org: null };
    const $ = cheerio.load(html);

    const name = ((ld.name as string) ?? '').trim();
    if (!name) return { ev: null, org: null };

    const location = (ld.location as Record<string, unknown>) ?? {};
    const venueName = ((location.name as string) ?? '').trim();
    const addr = (location.address as Record<string, unknown>) ?? {};
    const geo = (location.geo as Record<string, unknown>) ?? {};
    let venue: ScrapedVenue | null = null;
    if (venueName) {
      venue = {
        name: venueName,
        address: (addr.streetAddress as string) ?? '',
        city: (addr.addressLocality as string) ?? '',
        country: (addr.addressCountry as string) || 'Philippines',
        latitude: parseFloat(geo.latitude as string) || null,
        longitude: parseFloat(geo.longitude as string) || null,
        sourceUrl: listing.url,
      };
    }

    const performer = (ld.organizer as Record<string, unknown>) ?? {};
    const orgName = ((performer.name as string) ?? '').trim();
    const orgUrl = ((performer.url as string) ?? '').trim();

    let orgDesc = '';
    const bioEl = $('.bio-section');
    if (bioEl.length) orgDesc = bioEl.text().trim().substring(0, 1000);

    const offersArr = Array.isArray(ld.offers) ? ld.offers as Record<string, unknown>[] : ld.offers ? [ld.offers as Record<string, unknown>] : [];
    const prices = offersArr.map((o) => parseFloat(String(o.price ?? ''))).filter((p) => !isNaN(p));
    const minPrice = prices.length ? Math.min(...prices) : null;
    const priceStr = minPrice === null ? '' : minPrice === 0 ? 'Free' : `₱${minPrice.toLocaleString('en')}`;

    const externalIdMatch = listing.url.match(/\/events?\/([^/?]+)/);
    const externalId = externalIdMatch ? externalIdMatch[1] : '';

    return {
      ev: {
        name,
        description: ((ld.description as string) ?? '').substring(0, 5000),
        startsAt: parseDt(ld.startDate as string),
        endsAt: parseDt(ld.endDate as string),
        url: listing.url,
        imageUrl: (ld.image as string) || listing.imageUrl,
        price: priceStr,
        category: (ld['@type'] as string) ?? '',
        externalId,
        sourceUrl: SOURCE_URL,
        organizer: orgName,
        organizerUrl: orgUrl,
        venue,
      },
      org: orgName ? { name: orgName, sourceUrl: orgUrl, description: orgDesc, externalId: orgUrl } : null,
    };
  } catch (err) {
    console.error(`eventbookings: detail failed ${listing.url}:`, err);
    return { ev: null, org: null };
  }
};

export class EventBookingsScraper extends BaseScraper {
  readonly source = 'eventbookings';

  async run(): Promise<RunResult> {
    const listings = await fetchListings();
    console.log(`eventbookings: ${listings.length} listings`);

    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    for (const listing of listings) {
      const { ev, org } = await processListing(listing);
      if (ev) events.push(ev);
      if (org && !orgMap.has(org.externalId ?? org.name)) orgMap.set(org.externalId ?? org.name, org);
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`eventbookings: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
