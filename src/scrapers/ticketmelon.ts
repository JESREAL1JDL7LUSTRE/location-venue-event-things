import got from 'got';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { BaseScraper, type RunResult, type ScrapedEvent } from './base.js';
import { saveEvents } from './save.js';

const SITE = 'https://www.ticketmelon.com';
const SITEMAP_INDEX = `${SITE}/sitemap.xml`;
const SOURCE_URL = `${SITE}/events/upcoming`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)' };
const MAX_WORKERS = 6;

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

const fetchEventFromMeta = async (url: string): Promise<ScrapedEvent | null> => {
  try {
    const html = await got(url, { headers: HEADERS, timeout: { request: 20_000 } }).text();
    const $ = cheerio.load(html);

    const getMeta = (prop: string) =>
      $(`meta[property="${prop}"]`).attr('content')?.trim() ??
      $(`meta[name="${prop}"]`).attr('content')?.trim() ??
      '';

    const type = getMeta('og:type');
    if (type && type !== 'event') return null;

    const name = getMeta('og:title');
    if (!name) return null;

    const imageUrl = getMeta('og:image');
    const description = getMeta('og:description');
    const canonicalUrl = getMeta('og:url') || url;

    const externalIdMatch = canonicalUrl.match(/ticketmelon\.com\/([^/?#]+\/[^/?#]+)/);
    const externalId = externalIdMatch ? externalIdMatch[1] : '';

    return {
      name,
      description,
      startsAt: null,
      endsAt: null,
      url: canonicalUrl,
      imageUrl,
      price: '',
      category: '',
      externalId,
      sourceUrl: SOURCE_URL,
      organizer: '',
      organizerUrl: '',
      venue: null,
    };
  } catch { return null; }
};

export class TicketmelonScraper extends BaseScraper {
  readonly source = 'ticketmelon';

  async run(): Promise<RunResult> {
    const urls = await getSitemapEventUrls();
    console.log(`ticketmelon: ${urls.length} event URLs from sitemap`);

    const limit = pLimit(MAX_WORKERS);
    const results = await Promise.all(urls.map((url) => limit(() => fetchEventFromMeta(url))));

    const events: ScrapedEvent[] = results.filter((ev): ev is ScrapedEvent => ev !== null);

    console.log(`ticketmelon: ${events.length} events`);
    return saveEvents(this.source, events);
  }
}
