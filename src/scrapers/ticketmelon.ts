import got from 'got';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const SITE = 'https://www.ticketmelon.com';
const SITEMAP_INDEX = `${SITE}/sitemap.xml`;
const SOURCE_URL = `${SITE}/events/upcoming`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)' };
const MAX_WORKERS = 8;

const parseDt = (ts: unknown): Date | null => {
  if (!ts) return null;
  const n = typeof ts === 'number' ? ts : parseInt(String(ts), 10);
  if (isNaN(n)) return null;
  return new Date(n > 1e10 ? n : n * 1000);
};

const getSitemapEventUrls = async (): Promise<string[]> => {
  const indexXml = await got(SITEMAP_INDEX, { headers: HEADERS, timeout: { request: 20_000 } }).text();
  const sitemapUrls = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((u) => u.includes('sitemap-event'));
  const urls: string[] = [];
  for (const sitemapUrl of sitemapUrls) {
    try {
      const xml = await got(sitemapUrl, { headers: HEADERS, timeout: { request: 20_000 } }).text();
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      urls.push(...locs);
    } catch { /* skip */ }
  }
  return urls;
};

const fetchEventData = async (url: string): Promise<Record<string, unknown> | null> => {
  try {
    const html = await got(url, { headers: HEADERS, timeout: { request: 20_000 } }).text();
    const $ = cheerio.load(html);
    const script = $('script#__NEXT_DATA__').text();
    if (!script) return null;
    const json = JSON.parse(script);
    return (json?.props?.pageProps?.event as Record<string, unknown>) ?? null;
  } catch { return null; }
};

const toScraped = (event: Record<string, unknown>, url: string): { ev: ScrapedEvent; org: ScrapedOrganizer | null } | null => {
  const name = ((event.name as string) ?? '').trim();
  if (!name) return null;
  const currency = String(event.currency ?? '').toUpperCase();
  if (currency && currency !== 'PHP') return null;

  const tz = (event.timezone as Record<string, unknown>) ?? {};
  const tzCountry = (tz.country as string) ?? 'PH';
  if (tzCountry !== 'PH' && tzCountry !== 'Philippines') return null;

  const ticketTypes = (event.ticket_types as Record<string, unknown>[]) ?? [];
  const minPrice = ticketTypes.reduce((min: number | null, t) => {
    const p = parseFloat(String(t.price ?? ''));
    return isNaN(p) ? min : (min === null ? p : Math.min(min, p));
  }, null);
  const priceStr = minPrice === null ? '' : minPrice === 0 ? 'Free' : `₱${minPrice.toLocaleString('en')}`;

  const venue = (event.venue as Record<string, unknown>) ?? {};
  const venueName = ((venue.name as string) ?? '').trim();
  const venueAddr = (venue.address as Record<string, unknown>) ?? {};
  let sv: ScrapedVenue | null = null;
  if (venueName) {
    sv = {
      name: venueName,
      address: (venueAddr.street as string) ?? '',
      city: (venueAddr.city as string) ?? '',
      country: 'Philippines',
      latitude: (venue.lat as number) || null,
      longitude: (venue.lon as number) || null,
      sourceUrl: SOURCE_URL,
    };
  }

  const org = (event.organizer as Record<string, unknown>) ?? {};
  const orgName = ((org.name as string) ?? '').trim();
  const contactArr = (event.contacts as Record<string, unknown>[]) ?? [];
  const orgWebsite = contactArr.find((c) => c.type === 'website')?.value as string ?? '';

  const scrapedOrg: ScrapedOrganizer | null = orgName
    ? { name: orgName, externalId: String(org.id ?? ''), sourceUrl: SOURCE_URL, website: orgWebsite }
    : null;

  return {
    ev: {
      name,
      description: ((event.description as string) ?? '').replace(/<[^>]+>/g, '').trim(),
      startsAt: parseDt(event.start_date),
      endsAt: parseDt(event.end_date),
      url,
      imageUrl: (event.banner as string) ?? '',
      price: priceStr,
      category: ((event.category as Record<string, unknown>)?.name as string) ?? '',
      externalId: String(event.id ?? ''),
      sourceUrl: SOURCE_URL,
      organizer: orgName,
      organizerUrl: '',
      venue: sv,
    },
    org: scrapedOrg,
  };
};

export class TicketmelonScraper extends BaseScraper {
  readonly source = 'ticketmelon';

  async run(): Promise<RunResult> {
    const urls = await getSitemapEventUrls();
    console.log(`ticketmelon: ${urls.length} event URLs from sitemap`);

    const limit = pLimit(MAX_WORKERS);
    const results = await Promise.all(urls.map((url) => limit(() => fetchEventData(url).then((data) => ({ url, data })))));

    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    for (const { url, data } of results) {
      if (!data) continue;
      try {
        const parsed = toScraped(data, url);
        if (!parsed) continue;
        events.push(parsed.ev);
        if (parsed.org && !orgMap.has(parsed.org.externalId ?? parsed.org.name)) {
          orgMap.set(parsed.org.externalId ?? parsed.org.name, parsed.org);
        }
      } catch (err) {
        console.error(`ticketmelon: parse failed ${url}:`, err);
      }
    }

    console.log(`ticketmelon: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
