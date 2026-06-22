import got from 'got';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const BASE_API = 'https://2b67fmfmld.execute-api.ap-southeast-1.amazonaws.com/prod';
const ASSETS = 'https://assets.ticket2me.net/public/';
const SITE = 'https://www.ticket2me.net';
const SOURCE_URL = `${SITE}/events`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)', Accept: 'application/json' };

const get = async (path: string, params?: Record<string, string | number | boolean>): Promise<Record<string, unknown> | null> => {
  try {
    await new Promise((r) => setTimeout(r, 300));
    return await got(BASE_API + path, { headers: HEADERS, searchParams: params, timeout: { request: 20_000 } }).json<Record<string, unknown>>();
  } catch (err) {
    console.error(`ticket2me: request failed for ${path}:`, err);
    return null;
  }
};

const imageUrl = (path: string): string => path ? ASSETS + path : '';
const stripHtml = (text: string): string => (text ?? '').replace(/<[^>]+>/g, '').trim();
const priceStr = (val: unknown): string => {
  if (val === null || val === undefined || val === -1) return '';
  try { return `₱${parseFloat(String(val)).toLocaleString('en', { minimumFractionDigits: 2 })}`; } catch { return ''; }
};

const parseNaiveDt = (s: string): Date | null => {
  if (!s) return null;
  try {
    const d = new Date(s + ' UTC+08:00');
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
};

const sectionItems = (fp: Record<string, unknown>, key: string): Record<string, unknown>[] =>
  ((fp[key] as Record<string, unknown>)?.attributes as Record<string, unknown>[]) ?? [];

const collectEventIds = (fp: Record<string, unknown>): Map<number, Record<string, unknown>> => {
  const collected = new Map<number, Record<string, unknown>>();
  const add = (eid: unknown, price?: unknown, startDate?: unknown, endDate?: unknown) => {
    if (eid === null || eid === undefined) return;
    const id = parseInt(String(eid), 10);
    if (!collected.has(id)) collected.set(id, { price, start_date: startDate, end_date: endDate });
  };
  for (const item of sectionItems(fp, 'coming_soon')) add(item.event_id, item.price, item.start_date, item.end_date);
  for (const sec of ['featured', 'top'] as const) for (const item of sectionItems(fp, sec)) add(item.id, item.price);
  for (const row of sectionItems(fp, 'custom_rows')) {
    for (const item of ((row.items as Record<string, unknown>[]) ?? [])) {
      const ev = (item.event as Record<string, unknown>) ?? {};
      add(item.event_id ?? ev.id, ev.price);
    }
  }
  return collected;
};

export class Ticket2MeScraper extends BaseScraper {
  readonly source = 'ticket2me';

  async run(): Promise<RunResult> {
    const frontPage = await get('/events/front-page');
    if (!frontPage) return { source: this.source, created: 0, updated: 0, eventIds: [] };

    const listings = collectEventIds((frontPage.data as Record<string, unknown>) ?? {});
    console.log(`ticket2me: ${listings.size} unique events on front page`);

    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    for (const [eventId, listing] of listings) {
      const detail = await get(`/event/${eventId}`);
      if (!detail) continue;
      const attrs = ((detail.data as Record<string, unknown>)?.attributes as Record<string, unknown>) ?? {};
      if (!attrs) continue;

      const ed = (attrs.event_details as Record<string, unknown>) ?? {};
      const org = (attrs.organiser_details as Record<string, unknown>) ?? {};
      const vd = (ed.venue_details as Record<string, unknown>) ?? {};

      const tags = (ed.tags as string[]) ?? [];
      const category = tags.join(', ').substring(0, 120) || ((ed.type as string) ?? '');
      const organiserUrl = (org.organiser_url as string) ?? '';
      const orgUrl = organiserUrl ? `${SITE}/${organiserUrl}` : '';

      let venue: ScrapedVenue | null = null;
      if (vd.venue_name) {
        venue = {
          name: (vd.venue_name as string) ?? '',
          address: (vd.location_address as string) ?? '',
          city: (vd.location_state as string) ?? '',
          country: (vd.location_country as string) || 'Philippines',
          latitude: (vd.location_lat as number) || null,
          longitude: (vd.location_long as number) || null,
          sourceUrl: SOURCE_URL,
        };
      }

      let startsAt = parseNaiveDt((listing.start_date as string) ?? '');
      if (!startsAt) {
        const shows = await get(`/event/${eventId}/get_shows`);
        const showAttrs = ((shows?.data as Record<string, unknown>)?.attributes as Record<string, unknown>[]) ?? [];
        for (const entry of showAttrs) {
          const firstKey = Object.keys(entry)[0];
          if (firstKey) { startsAt = parseNaiveDt(firstKey); break; }
        }
      }

      const eventName = (ed.title as string) ?? '';
      if (!eventName) continue;

      events.push({
        name: eventName,
        description: stripHtml((ed.description as string) ?? ''),
        startsAt,
        endsAt: parseNaiveDt((listing.end_date as string) ?? ''),
        url: `${SITE}/event/${eventId}`,
        imageUrl: imageUrl((ed.bg_image_path as string) || (ed.event_tile_image_path as string) || ''),
        price: priceStr(listing.price),
        category,
        externalId: String(ed.id ?? eventId),
        sourceUrl: SOURCE_URL,
        organizer: (org.name as string) ?? '',
        organizerUrl: orgUrl,
        venue,
      });

      const orgId = String(org.id ?? '');
      if (orgId && org.name && !orgMap.has(orgId)) {
        orgMap.set(orgId, {
          name: (org.name as string) ?? '',
          externalId: orgId,
          website: orgUrl,
          email: (org.email as string) ?? '',
          phone: (org.phone as string) ?? '',
          description: (org.about as string) ?? '',
          facebookUrl: (org.facebook as string) ?? '',
          sourceUrl: SOURCE_URL,
        });
      }
    }

    console.log(`ticket2me: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
