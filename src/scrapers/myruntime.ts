import got from 'got';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const API_URL = 'https://myruntime.com/appEventsService/api/v1/getAppEvents';
const EVENTS_PAGE = 'https://myruntime.com/events';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)' };

const parseDt = (s: string | undefined): Date | null => {
  if (!s) return null;
  try { return new Date(s.replace('Z', '+00:00')); } catch { return null; }
};

const extractCity = (location: string): string => {
  const parts = location.split(',').map((p) => p.trim());
  return parts.length > 1 ? parts[parts.length - 1] : '';
};

const organizerSubdomain = (regUrl: string): string => {
  try {
    const hostname = new URL(regUrl).hostname;
    const subdomain = hostname.split('.')[0];
    return subdomain === 'myruntime' || !subdomain ? 'direct' : subdomain;
  } catch { return 'direct'; }
};

const eventExternalId = (regUrl: string, name: string): string => {
  try {
    const pathname = new URL(regUrl).pathname;
    const m = pathname.match(/\/register\/(.+)$/);
    if (m) return m[1];
    const subdomain = organizerSubdomain(regUrl);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `${subdomain}/${slug}`;
  } catch {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
};

const bestUrl = (links: Record<string, string>): string =>
  links.website || links.facebook || links.instagram || links.twitter || '';

export class MyRuntimeScraper extends BaseScraper {
  readonly source = 'myruntime';

  async run(): Promise<RunResult> {
    let data: Record<string, unknown>[] = [];
    try {
      const resp = await got(API_URL, { headers: HEADERS, searchParams: { limit: 2000 }, timeout: { request: 15_000 } }).json<{ data: Record<string, unknown>[] }>();
      data = resp.data ?? [];
    } catch (err) {
      console.warn('MyRuntime API failed:', err);
      data = [];
    }
    console.log(`myruntime: ${data.length} events`);

    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    for (const item of data) {
      const name = ((item.name as string) ?? '').trim();
      if (!name) continue;
      const regUrl = (item.regUrl as string) ?? '';
      const locations = (item.location as string[]) ?? [];
      const locationStr = locations[0] ?? '';
      const tickets = (item.tickets as Array<Record<string, unknown>>) ?? [];
      const extLinks = (item.externalLinks as Record<string, string>) ?? {};

      let venue: ScrapedVenue | null = null;
      if (locationStr) {
        venue = { name: locationStr, city: extractCity(locationStr), country: 'Philippines', sourceUrl: EVENTS_PAGE };
      }

      const ticketNames = tickets.map((t) => t.name as string).filter(Boolean);
      const organizerName = regUrl ? organizerSubdomain(regUrl) : '';

      events.push({
        name,
        startsAt: parseDt(item.eventDate as string),
        endsAt: parseDt(item.eventDateEnd as string),
        url: regUrl,
        imageUrl: (item.bannerImage as string) || (item.thumbnail as string) || '',
        category: ticketNames.join(', ').substring(0, 120),
        externalId: regUrl ? eventExternalId(regUrl, name) : '',
        sourceUrl: EVENTS_PAGE,
        organizer: organizerName,
        organizerUrl: bestUrl(extLinks),
        venue,
      });

      const subdomain = regUrl ? organizerSubdomain(regUrl) : '';
      if (subdomain && !orgMap.has(subdomain)) {
        orgMap.set(subdomain, {
          name: subdomain,
          externalId: subdomain,
          sourceUrl: EVENTS_PAGE,
          website: extLinks.website ?? '',
          facebookUrl: extLinks.facebook ?? '',
          instagramUrl: extLinks.instagram ?? '',
        });
      } else if (subdomain) {
        const org = orgMap.get(subdomain)!;
        if (!org.website) org.website = extLinks.website ?? '';
        if (!org.facebookUrl) org.facebookUrl = extLinks.facebook ?? '';
        if (!org.instagramUrl) org.instagramUrl = extLinks.instagram ?? '';
      }
    }

    console.log(`myruntime: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
