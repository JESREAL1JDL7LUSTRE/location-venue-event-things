import got from 'got';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const EVENTS_API = 'https://script.google.com/macros/s/AKfycbz0IYaNlcASnvaGNOu7gNmlieWx3DYWp8B0Bhc5UFNAWRweVftYOzmzQYa8CMjWam7nLg/exec?q=events';
const RECURRING_API = 'https://script.google.com/macros/s/AKfycbw8CyZSz1BHWzrCfD7bMNz-Hrpk7wAjw4QWv7wgWXSAgXzOfHX5Zb6QTiH-siCJoRJXfw/exec?q=events';
const SITE = 'https://www.racemeister.com/';
const SOURCE_URL = 'https://www.racemeister.com/events';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)' };

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const parseDate = (dateStr: string): [Date | null, Date | null] => {
  if (!dateStr) return [null, null];
  const rangeMatch = dateStr.match(/^([A-Za-z]+)\s+(\d{1,2})-(\d{1,2}),\s*(\d{4})$/);
  if (rangeMatch) {
    const [, month, startDay, endDay, year] = rangeMatch;
    const m = MONTHS[month.toLowerCase()];
    if (m === undefined) return [null, null];
    const y = parseInt(year, 10);
    return [new Date(y, m, parseInt(startDay, 10)), new Date(y, m, parseInt(endDay, 10))];
  }
  const singleMatch = dateStr.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (singleMatch) {
    const [, month, day, year] = singleMatch;
    const m = MONTHS[month.toLowerCase()];
    if (m === undefined) return [null, null];
    return [new Date(parseInt(year, 10), m, parseInt(day, 10)), null];
  }
  return [null, null];
};

const externalId = (item: Record<string, unknown>): string => {
  const page = ((item.Page as string) ?? '').trim();
  if (page && page !== '#') {
    const segment = page.replace(/\/$/, '').split('/').pop() ?? '';
    const slug = segment.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slug) return slug;
  }
  const name = ((item.Race as string) ?? '').trim();
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
};

const resolvePageUrl = (item: Record<string, unknown>): string => {
  const page = ((item.Page as string) ?? '').trim();
  if (page && page !== '#') {
    if (page.startsWith('http')) return page;
    return SITE + page.replace(/^\//, '');
  }
  return ((item.Website as string) ?? '').trim();
};

const buildOrganizers = (items: Record<string, unknown>[]): ScrapedOrganizer[] => {
  const seen = new Map<string, ScrapedOrganizer>();
  for (const item of items) {
    const namesRaw = ((item.Organizer as string) ?? '').trim();
    const website = ((item.Website as string) ?? '').trim();
    for (const name of namesRaw.split(',').map((n) => n.trim()).filter(Boolean)) {
      const extId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!seen.has(extId)) {
        const isFacebook = website.startsWith('https://www.facebook.com');
        seen.set(extId, {
          name,
          externalId: extId,
          sourceUrl: SOURCE_URL,
          website: isFacebook ? '' : website,
          facebookUrl: isFacebook ? website : '',
        });
      }
    }
  }
  return [...seen.values()];
};

const fetchEvents = async (url: string): Promise<Record<string, unknown>[]> => {
  try {
    const data = await got(url, { headers: HEADERS, timeout: { request: 30_000 }, followRedirect: true }).json<unknown>();
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    if (data && typeof data === 'object') {
      for (const v of Object.values(data as object)) {
        if (Array.isArray(v)) return v as Record<string, unknown>[];
      }
    }
    return [];
  } catch (err) {
    console.error(`racemeister_events: request failed for ${url}:`, err);
    return [];
  }
};

export class RacemeisterEventsScraper extends BaseScraper {
  readonly source = 'racemeister_events';

  async run(): Promise<RunResult> {
    const items = [...await fetchEvents(EVENTS_API), ...await fetchEvents(RECURRING_API)];
    console.log(`racemeister_events: ${items.length} raw events`);

    const seenIds = new Set<string>();
    const events: ScrapedEvent[] = [];

    for (const item of items) {
      const name = ((item.Race as string) ?? '').trim();
      if (!name) continue;
      const extId = externalId(item);
      if (seenIds.has(extId)) continue;
      seenIds.add(extId);
      const [startsAt, endsAt] = parseDate((item.Date as string) ?? '');
      const description = ((item.Description as string) ?? '').replace(/<br\s*\/?>/gi, '\n').trim();

      let venue: ScrapedVenue | null = null;
      const address = ((item.Address as string) ?? '').trim();
      if (address) {
        const parts = address.split(',').map((p: string) => p.trim()).filter(Boolean);
        const city = parts.length > 1 ? parts[parts.length - 1] : '';
        venue = { name: address, city, country: 'Philippines', sourceUrl: SOURCE_URL };
      }

      events.push({
        name, description, startsAt, endsAt,
        url: resolvePageUrl(item),
        imageUrl: ((item.Image as string) ?? '').trim(),
        price: '',
        category: ((item.Classification as string) ?? '').trim(),
        externalId: extId,
        sourceUrl: SOURCE_URL,
        organizer: ((item.Organizer as string) ?? '').trim(),
        organizerUrl: ((item.Website as string) ?? '').trim(),
        venue,
      });
    }

    const organizers = buildOrganizers(items);
    console.log(`racemeister_events: ${events.length} events, ${organizers.length} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, organizers);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
