import got from 'got';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const API = 'https://api-v2.planout.io';
const SITE = 'https://planout.io';
const SOURCE_URL = `${SITE}/events`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)', Accept: 'application/json' };

const parseDt = (s: string | undefined): Date | null => {
  if (!s) return null;
  try { return new Date(s.replace('Z', '+00:00')); } catch { return null; }
};

const toFloat = (val: unknown): number | null => {
  if (val === null || val === undefined || val === '') return null;
  const f = parseFloat(String(val));
  return isNaN(f) ? null : f;
};

const fetchAllEvents = async (): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  let page = 1;
  while (true) {
    try {
      const payload = await got(`${API}/api/events`, {
        headers: HEADERS,
        searchParams: { limit: 50, page },
        timeout: { request: 20_000 },
      }).json<Record<string, unknown>>();
      items.push(...((payload.data as Record<string, unknown>[]) ?? []));
      if (!(payload.links as Record<string, unknown>)?.next) break;
      page++;
    } catch (err) {
      console.error(`planout: page ${page} failed:`, err);
      break;
    }
  }
  return items;
};

const parseVenue = (item: Record<string, unknown>): ScrapedVenue | null => {
  const address = ((item.address as string) ?? '').trim();
  if (!address) return null;
  const segments = address.split(',').map((s) => s.trim()).filter(Boolean);
  const name = segments[0] ?? address;
  const city = segments.length > 1 ? segments[segments.length - 1] : '';
  return { name, address, city, latitude: toFloat(item.lat), longitude: toFloat(item.long), sourceUrl: SOURCE_URL };
};

const facebookUrl = (links: unknown[]): string => {
  for (const link of links ?? []) {
    const l = link as Record<string, unknown>;
    if (l.type === 'facebook') return (l.url as string) ?? '';
  }
  return '';
};

const category = (item: Record<string, unknown>): string => {
  const tags = (item.tags as Array<Record<string, unknown>>) ?? [];
  const names = tags.filter((t) => t.type_label === 'category').map((t) => (t.name as string) ?? '').filter(Boolean);
  return names.join(', ').substring(0, 120);
};

const buildEvent = (item: Record<string, unknown>): ScrapedEvent => {
  const team = (item.team as Record<string, unknown>) ?? {};
  const desc = ((item.description as string) ?? '').replace(/<[^>]+>/g, '').trim();
  const coverPhoto = (item.cover_photo as Record<string, unknown>) ?? {};
  return {
    name: (item.name as string) ?? '',
    description: desc,
    startsAt: parseDt(item.start as string),
    endsAt: parseDt(item.end as string),
    url: `${SITE}/event/${item.slug}`,
    imageUrl: (coverPhoto.url as string) ?? '',
    price: '',
    category: category(item),
    externalId: String(item.id ?? ''),
    sourceUrl: SOURCE_URL,
    organizer: (team.name as string) ?? '',
    organizerUrl: '',
    venue: parseVenue(item),
  };
};

export class PlanoutScraper extends BaseScraper {
  readonly source = 'planout';

  async run(): Promise<RunResult> {
    const items = await fetchAllEvents();
    const events = items.filter((i) => i.name).map(buildEvent);
    const orgMap = new Map<string, ScrapedOrganizer>();
    for (const item of items) {
      const team = (item.team as Record<string, unknown>) ?? {};
      const teamId = team.id;
      if (teamId === undefined) continue;
      const key = String(teamId);
      if (orgMap.has(key)) continue;
      orgMap.set(key, {
        name: (team.name as string) ?? '',
        description: (team.description as string) ?? '',
        email: (team.email as string) ?? '',
        phone: (team.mobile as string) ?? '',
        facebookUrl: facebookUrl((team.links as unknown[]) ?? []),
        externalId: key,
        sourceUrl: SOURCE_URL,
      });
    }
    console.log(`planout: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
