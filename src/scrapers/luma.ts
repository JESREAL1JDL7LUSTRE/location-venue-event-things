import got from 'got';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const API_URL = 'https://api.lu.ma/discover/get-paginated-events';
const LUMA_BASE = 'https://lu.ma';
const SOURCE_URL = 'https://lu.ma/discover';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)' };

const PH_LOCATIONS = [
  [14.5958, 120.9772, 100],
  [10.3157, 123.8854, 100],
  [7.1907, 125.4553, 100],
] as const;

const parseDt = (s: string | undefined): Date | null => {
  if (!s) return null;
  try { return new Date(s); } catch { return null; }
};

const priceStr = (ticket: Record<string, unknown>): string => {
  if (!ticket) return '';
  if (ticket.is_free) return 'Free';
  const price = (ticket.price as Record<string, unknown>) ?? {};
  const cents = price.cents as number | undefined;
  if (cents === undefined) return '';
  const amount = cents / 100;
  const maxP = (ticket.max_price as Record<string, unknown>) ?? {};
  const maxCents = maxP.cents as number | undefined;
  if (maxCents && maxCents !== cents) return `₱${amount.toLocaleString('en')}-₱${(maxCents / 100).toLocaleString('en')}`;
  return `₱${amount.toLocaleString('en')}`;
};

const buildVenue = (ev: Record<string, unknown>): ScrapedVenue | null => {
  const geo = (ev.geo_address_info as Record<string, unknown>) ?? {};
  const coord = (ev.coordinate as Record<string, unknown>) ?? {};
  const name = ((geo.address as string) || (geo.full_address as string) || '').trim();
  if (!name) return null;
  return {
    name,
    address: (geo.full_address as string) ?? '',
    city: (geo.city as string) ?? '',
    country: (geo.country as string) || 'Philippines',
    latitude: coord.latitude as number | undefined,
    longitude: coord.longitude as number | undefined,
    sourceUrl: SOURCE_URL,
  };
};

const fetchLocation = async (lat: number, lon: number, radius: number): Promise<Record<string, unknown>[]> => {
  const entries: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  while (true) {
    const params: Record<string, string | number> = { latitude: lat, longitude: lon, radius_km: radius };
    if (cursor) params.pagination_cursor = cursor;
    try {
      const data = await got(API_URL, { headers: HEADERS, searchParams: params, timeout: { request: 15_000 } }).json<Record<string, unknown>>();
      entries.push(...((data.entries as Record<string, unknown>[]) ?? []));
      if (!data.has_more) break;
      cursor = (data.next_cursor as string) ?? null;
      if (!cursor) break;
    } catch (err) {
      console.warn(`luma: request failed lat=${lat} lon=${lon}: ${err}`);
      break;
    }
  }
  return entries;
};

export class LumaScraper extends BaseScraper {
  readonly source = 'luma';

  private async collectAll(): Promise<Record<string, unknown>[]> {
    const seen = new Set<string>();
    const all: Record<string, unknown>[] = [];
    for (const [lat, lon, radius] of PH_LOCATIONS) {
      for (const entry of await fetchLocation(lat, lon, radius)) {
        const apiId = entry.api_id as string | undefined;
        if (apiId && !seen.has(apiId)) {
          seen.add(apiId);
          all.push(entry);
        }
      }
    }
    console.log(`luma: collected ${all.length} unique events`);
    return all;
  }

  async run(): Promise<RunResult> {
    const items = await this.collectAll();
    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    for (const entry of items) {
      const ev = (entry.event as Record<string, unknown>) ?? {};
      const name = ((ev.name as string) ?? '').trim();
      if (!name) continue;

      const urlSlug = ((ev.url as string) ?? '').trim();
      const cal = (entry.calendar as Record<string, unknown>) ?? {};
      const hosts = (entry.hosts as Array<Record<string, unknown>>) ?? [];
      const organizerName = ((cal.name as string) || (hosts[0]?.name as string) || '').trim();

      events.push({
        name,
        startsAt: parseDt(ev.start_at as string),
        endsAt: parseDt(ev.end_at as string),
        url: urlSlug ? `${LUMA_BASE}/${urlSlug}` : '',
        imageUrl: (ev.cover_url as string) ?? '',
        price: priceStr((entry.ticket_info as Record<string, unknown>) ?? {}),
        category: '',
        externalId: (entry.api_id as string) ?? '',
        sourceUrl: SOURCE_URL,
        organizer: organizerName.substring(0, 255),
        organizerUrl: (cal.website as string) ?? '',
        venue: buildVenue(ev),
      });

      const calId = cal.api_id as string | undefined;
      if (calId && !orgMap.has(calId)) {
        const ig = (cal.instagram_handle as string) ?? '';
        orgMap.set(calId, {
          name: organizerName,
          externalId: calId,
          sourceUrl: SOURCE_URL,
          website: (cal.website as string) ?? '',
          instagramUrl: ig ? `https://www.instagram.com/${ig}` : '',
          description: ((cal.description_short as string) ?? '').substring(0, 500),
        });
      }
    }

    console.log(`luma: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
