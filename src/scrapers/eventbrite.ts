import got from 'got';
import * as cheerio from 'cheerio';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const LISTING_URL = 'https://www.eventbrite.com/d/{location}/all-events/';
const API_URL = 'https://www.eventbrite.com/api/v3/destination/events/';
const API_EXPAND = 'event_sales_status,image,primary_venue,ticket_availability,primary_organizer';
const SOURCE_URL = 'https://www.eventbrite.com/d/philippines/all-events/';
const MAX_PAGES = 10;
const PH_LOCATIONS = ['philippines--manila', 'philippines--cebu', 'philippines--davao-city'];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)' };

const parseDt = (date: string, time: string, tz: string): Date | null => {
  if (!date) return null;
  try {
    return new Date(`${date}T${time || '00:00'}:00+08:00`);
  } catch { return null; }
};

const priceStr = (ta: Record<string, unknown>): string => {
  if (!ta) return '';
  if (ta.is_free) return 'Free';
  const minP = (ta.minimum_ticket_price as Record<string, unknown>) ?? {};
  const maxP = (ta.maximum_ticket_price as Record<string, unknown>) ?? {};
  const minVal = minP.major_value;
  if (minVal === undefined || minVal === null) return '';
  const minAmt = parseFloat(String(minVal));
  const maxVal = maxP.major_value;
  if (maxVal && parseFloat(String(maxVal)) !== minAmt) return `₱${minAmt.toLocaleString('en')}-₱${parseFloat(String(maxVal)).toLocaleString('en')}`;
  return `₱${minAmt.toLocaleString('en')}`;
};

const categoryFromTags = (tags: Array<Record<string, unknown>>): string => {
  for (const tag of tags ?? []) {
    if (tag.prefix === 'EventbriteCategory') return (tag.display_name as string) ?? '';
  }
  return '';
};

const facebookUrl = (fb: string | undefined): string => {
  if (!fb) return '';
  if (fb.startsWith('http')) return fb;
  if (/^\d+$/.test(fb)) return `https://www.facebook.com/profile.php?id=${fb}`;
  return `https://www.facebook.com/${fb}`;
};

const buildVenue = (ev: Record<string, unknown>): ScrapedVenue | null => {
  if (ev.is_online_event) return null;
  const venue = (ev.primary_venue as Record<string, unknown>) ?? {};
  const name = ((venue.name as string) ?? '').trim();
  if (!name) return null;
  const addr = (venue.address as Record<string, unknown>) ?? {};
  const city = (addr.city as string) || (addr.region as string) || '';
  const countryCode = (addr.country as string) || 'PH';
  return {
    name,
    address: (addr.address_1 as string) ?? '',
    city,
    country: countryCode === 'PH' ? 'Philippines' : countryCode,
    latitude: parseFloat(addr.latitude as string) || null,
    longitude: parseFloat(addr.longitude as string) || null,
    sourceUrl: (ev.url as string) ?? '',
  };
};

const buildOrganizer = (org: Record<string, unknown>): ScrapedOrganizer | null => {
  const name = ((org.name as string) ?? '').trim();
  const orgId = String(org.id ?? '').trim();
  if (!name || !orgId) return null;
  return {
    name,
    externalId: orgId,
    sourceUrl: (org.url as string) ?? '',
    website: (org.website_url as string) ?? '',
    facebookUrl: facebookUrl(org.facebook as string),
    description: ((org.summary as string) ?? '').substring(0, 500),
  };
};

const getPageIds = async (location: string, page: number): Promise<string[]> => {
  let url = LISTING_URL.replace('{location}', location);
  if (page > 1) url += `?page=${page}`;
  try {
    const html = await got(url, { headers: HEADERS, timeout: { request: 25_000 } }).text();
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const ids: string[] = [];
    $('a[data-event-id]').each((_, el) => {
      const eid = ($(el).attr('data-event-id') ?? '').trim();
      if (eid && !seen.has(eid)) { seen.add(eid); ids.push(eid); }
    });
    return ids;
  } catch (err) {
    console.error(`eventbrite: listing failed ${location} p${page}:`, err);
    return [];
  }
};

const fetchDetails = async (eventIds: string[]): Promise<Record<string, unknown>[]> => {
  if (!eventIds.length) return [];
  try {
    const resp = await got(API_URL, {
      headers: HEADERS,
      searchParams: { event_ids: eventIds.join(','), page_size: eventIds.length, expand: API_EXPAND },
      timeout: { request: 25_000 },
    }).json<{ events: Record<string, unknown>[] }>();
    return resp.events ?? [];
  } catch (err) {
    console.error(`eventbrite: API failed for ${eventIds.length} events:`, err);
    return [];
  }
};

export class EventbriteScraper extends BaseScraper {
  readonly source = 'eventbrite';

  async run(): Promise<RunResult> {
    const seen = new Set<string>();
    const allEvents: Record<string, unknown>[] = [];

    for (const location of PH_LOCATIONS) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const ids = await getPageIds(location, page);
        if (!ids.length) break;
        const newIds = ids.filter((id) => !seen.has(id));
        ids.forEach((id) => seen.add(id));
        if (newIds.length) {
          const batch = await fetchDetails(newIds);
          allEvents.push(...batch);
        }
      }
    }
    console.log(`eventbrite: collected ${allEvents.length} unique events`);

    const events: ScrapedEvent[] = [];
    const seenOrgs = new Set<string>();
    const organizers: ScrapedOrganizer[] = [];

    for (const ev of allEvents) {
      const name = ((ev.name as string) ?? '').trim();
      if (!name) continue;
      const tz = (ev.timezone as string) || 'Asia/Manila';
      const org = (ev.primary_organizer as Record<string, unknown>) ?? {};
      const img = (ev.image as Record<string, unknown>) ?? {};

      events.push({
        name,
        startsAt: parseDt(ev.start_date as string, ev.start_time as string, tz),
        endsAt: parseDt(ev.end_date as string, ev.end_time as string, tz),
        url: (ev.url as string) ?? '',
        imageUrl: (img.url as string) ?? '',
        price: priceStr((ev.ticket_availability as Record<string, unknown>) ?? {}),
        category: categoryFromTags((ev.tags as Array<Record<string, unknown>>) ?? []),
        externalId: String(ev.id ?? ''),
        sourceUrl: SOURCE_URL,
        organizer: ((org.name as string) ?? '').substring(0, 255),
        organizerUrl: (org.url as string) ?? '',
        venue: buildVenue(ev),
      });

      const orgId = String(org.id ?? '');
      if (orgId && !seenOrgs.has(orgId)) {
        seenOrgs.add(orgId);
        const o = buildOrganizer(org);
        if (o) organizers.push(o);
      }
    }

    console.log(`eventbrite: ${events.length} events, ${organizers.length} organizers`);
    const orgResult = await saveOrganizers(this.source, organizers);
    const evResult = await saveEvents(this.source, events);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
