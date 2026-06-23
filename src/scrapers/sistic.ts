import got from 'got';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const API = 'https://cms.sistic.com.sg/api';
const SOURCE_URL = 'https://www.sistic.com.sg/events';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)', Accept: 'application/json' };
const PAGE_SIZE = 30;

const parseSGDate = (s: string): Date | null => {
  if (!s) return null;
  try {
    // Format: "Wed, 30 Nov 2022"
    const d = new Date(s + ' 00:00:00 +0800');
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
};

const fetchAllListings = async (): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  let first = 0;
  while (true) {
    try {
      const resp = await got(`${API}/events`, {
        headers: HEADERS,
        searchParams: { limit: PAGE_SIZE, first },
        timeout: { request: 25_000 },
      }).json<{ data: Record<string, unknown>[]; total_records?: number }>();
      const data = resp.data ?? [];
      items.push(...data);
      const total = resp.total_records ?? 0;
      if (!data.length || items.length >= total) break;
      first += data.length;
    } catch (err) {
      console.error(`sistic: listing (first=${first}) failed:`, err);
      break;
    }
  }
  return items;
};

const fetchDetail = async (alias: string): Promise<Record<string, unknown> | null> => {
  try {
    return await got(`${API}/event-detail`, {
      headers: HEADERS,
      searchParams: { client: 1, code: alias },
      timeout: { request: 25_000 },
    }).json<Record<string, unknown>>();
  } catch { return null; }
};

export class SisticScraper extends BaseScraper {
  readonly source = 'sistic';

  async run(): Promise<RunResult> {
    const listings = await fetchAllListings();
    console.log(`sistic: ${listings.length} listings`);

    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    for (const listing of listings) {
      const alias = String(listing.alias ?? listing.code ?? '');
      if (!alias) continue;

      const detail = await fetchDetail(alias);
      if (!detail) continue;

      const name = ((detail.name as string) ?? '').trim();
      if (!name) continue;

      const venue = (detail.venue as Record<string, unknown>) ?? {};
      let sv: ScrapedVenue | null = null;
      if (venue.name) {
        sv = {
          name: (venue.name as string) ?? '',
          address: (venue.address as string) ?? '',
          city: 'Singapore',
          country: 'SG',
          latitude: (venue.latitude as number) || null,
          longitude: (venue.longitude as number) || null,
          sourceUrl: SOURCE_URL,
        };
      }

      const promoters = (detail.promoters as Record<string, unknown>[]) ?? [];
      const promo = promoters[0] ?? {};
      const orgName = ((promo.name as string) ?? '').trim();

      const images = (detail.images as Array<Record<string, unknown>>) ?? [];
      const imageUrl = (images[0]?.url as string) ?? '';

      const externalId = alias;
      const eventUrl = `https://www.sistic.com.sg/events/${alias}`;

      events.push({
        name,
        description: ((detail.description as string) ?? '').replace(/<[^>]+>/g, '').trim(),
        startsAt: parseSGDate(detail.start_date as string),
        endsAt: parseSGDate(detail.end_date as string),
        url: eventUrl,
        imageUrl,
        price: '',
        category: ((detail.category as string) ?? '').trim(),
        externalId,
        sourceUrl: SOURCE_URL,
        organizer: orgName,
        organizerUrl: (promo.website as string) ?? '',
        venue: sv,
      });

      if (orgName && !orgMap.has(orgName)) {
        orgMap.set(orgName, {
          name: orgName,
          email: (promo.email as string) ?? '',
          website: (promo.website as string) ?? '',
          externalId: String(promo.id ?? ''),
          sourceUrl: SOURCE_URL,
        });
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`sistic: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
