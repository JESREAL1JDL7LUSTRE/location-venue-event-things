import got from 'got';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const SITE = 'https://eventsize.com';
const SOURCE_URL = `${SITE}/philippines`;
const API = `${SITE}/API/v1.0/index.php`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)' };

const PH_LOCATIONS = [
  'manila', 'cebu', 'davao', 'quezon-city', 'cagayan-de-oro', 'makati',
  'taguig', 'pasig', 'parañaque', 'mandaluyong', 'marikina', 'pasay',
  'caloocan', 'malabon', 'navotas', 'valenzuela', 'las-piñas',
  'muntinlupa',
];

const SCHEMA_TYPES = new Set([
  'Event', 'TheaterEvent', 'MusicEvent', 'SportsEvent', 'BusinessEvent',
  'FoodEvent', 'Festival', 'SaleEvent', 'ChildrensEvent', 'ComedyEvent', 'EducationEvent',
]);

const parseDate = (s: string): Date | null => {
  if (!s) return null;
  // Normalize non-standard offsets like "+8.00" → "+08:00"
  const fixed = s.replace(/([+-])(\d)\.(\d{2})$/, (_, sign, h, m) => `${sign}0${h}:${m}`)
    .replace(/([+-])(\d{2})\.(\d{2})$/, (_, sign, h, m) => `${sign}${h}:${m}`);
  try { return new Date(fixed); } catch { return null; }
};

const extractLdJson = (html: string): Record<string, unknown> | null => {
  const matches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)];
  for (const match of matches) {
    try {
      const data = JSON.parse(match[1]);
      const items: unknown[] = Array.isArray(data)
        ? data
        : (data['@graph'] as unknown[] ?? [data]);
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const t = (item as Record<string, unknown>)['@type'];
        const type = Array.isArray(t) ? String(t[0]) : String(t ?? '');
        if (SCHEMA_TYPES.has(type)) return item as Record<string, unknown>;
      }
    } catch { /* skip */ }
  }
  return null;
};

const fetchEventPage = async (url: string): Promise<{ ev: ScrapedEvent | null; org: ScrapedOrganizer | null }> => {
  try {
    const html = await got(url, { headers: HEADERS, timeout: { request: 20_000 } }).text();
    const ld = extractLdJson(html);
    if (!ld) return { ev: null, org: null };
    const $ = cheerio.load(html);

    const name = ((ld.name as string) ?? '').trim();
    if (!name) return { ev: null, org: null };

    const location = (ld.location as Record<string, unknown>) ?? {};
    const addr = (location.address as Record<string, unknown>) ?? {};
    const geo = (location.geo as Record<string, unknown>) ?? {};
    const venueName = ((location.name as string) ?? '').trim();
    let venue: ScrapedVenue | null = null;
    if (venueName) {
      venue = {
        name: venueName,
        address: (addr.streetAddress as string) ?? '',
        city: (addr.addressLocality as string) ?? '',
        country: (addr.addressCountry as string) || 'PH',
        latitude: parseFloat(geo.latitude as string) || null,
        longitude: parseFloat(geo.longitude as string) || null,
        sourceUrl: url,
      };
    }

    const orgData = (ld.organizer as Record<string, unknown>) ?? {};
    const orgName = ((orgData.name as string) ?? '').trim();
    const orgUrl = ((orgData.url as string) ?? '').trim();

    // Extract email + socials from organizer profile if URL looks like eventsize org page
    let orgEmail = '';
    let orgFbUrl = '';
    let orgIgUrl = '';
    if (orgUrl && orgUrl.includes('eventsize.com/@')) {
      try {
        const orgHtml = await got(orgUrl, { headers: HEADERS, timeout: { request: 15_000 } }).text();
        const $org = cheerio.load(orgHtml);
        $org('a[href^="mailto:"]').first().each((_, el) => {
          orgEmail = ($org(el).attr('href') ?? '').replace('mailto:', '').split('?')[0].trim();
        });
        $org('a[href*="facebook.com/"]').first().each((_, el) => { orgFbUrl = $org(el).attr('href') ?? ''; });
        $org('a[href*="instagram.com/"]').first().each((_, el) => { orgIgUrl = $org(el).attr('href') ?? ''; });
      } catch { /* skip */ }
    }

    const externalIdMatch = url.match(/eventsize\.com\/([^/?]+)/);
    const externalId = externalIdMatch ? externalIdMatch[1] : '';

    return {
      ev: {
        name,
        description: ((ld.description as string) ?? '').substring(0, 5000),
        startsAt: parseDate(ld.startDate as string),
        endsAt: parseDate(ld.endDate as string),
        url,
        imageUrl: (ld.image as string) ?? '',
        price: '',
        category: String((ld['@type'] as string) ?? ''),
        externalId,
        sourceUrl: SOURCE_URL,
        organizer: orgName,
        organizerUrl: orgUrl,
        venue,
      },
      org: orgName ? {
        name: orgName, website: orgUrl, email: orgEmail,
        facebookUrl: orgFbUrl, instagramUrl: orgIgUrl,
        externalId: orgUrl, sourceUrl: orgUrl,
      } : null,
    };
  } catch (err) {
    console.error(`eventsize: page failed ${url}:`, err instanceof Error ? err.message : String(err));
    return { ev: null, org: null };
  }
};

const apiDiscoverUrls = async (): Promise<Set<string>> => {
  const urls = new Set<string>();
  for (const location of PH_LOCATIONS) {
    try {
      const data = await got(API, {
        headers: HEADERS,
        searchParams: { system: 'offers', type: 'public-unique', location },
        timeout: { request: 20_000 },
      }).json<unknown>();
      if (Array.isArray(data)) {
        for (const item of data) {
          const url = (item as Record<string, unknown>)?.url as string;
          if (url && url.startsWith('http')) urls.add(url);
        }
      }
    } catch (err) {
      console.error(`eventsize: API failed for ${location}:`, err instanceof Error ? err.message : String(err));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return urls;
};

const googleSearchUrls = async (): Promise<Set<string>> => {
  const found = new Set<string>();
  const queries = [
    'site:eventsize.com event Philippines 2026',
    'site:eventsize.com festival Manila 2026',
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const query of queries) {
      const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
      const page = await context.newPage();
      try {
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=30`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(1500);
        const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href));
        for (const link of links) {
          if (typeof link === 'string' && link.includes('eventsize.com/') && !link.includes('eventsize.com/API') && !link.includes('eventsize.com/@')) {
            try {
              const parsed = new URL(link);
              if (parsed.hostname === 'eventsize.com' && parsed.pathname.length > 1) {
                found.add(`https://eventsize.com${parsed.pathname}`);
              }
            } catch { /* */ }
          }
        }
      } catch { /* skip */ }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return found;
};

export class EventsizeScraper extends BaseScraper {
  readonly source = 'eventsize';

  async run(): Promise<RunResult> {
    const [apiUrls, googleUrls] = await Promise.all([apiDiscoverUrls(), googleSearchUrls()]);
    const allUrls = new Set([...apiUrls, ...googleUrls]);
    console.log(`eventsize: ${allUrls.size} unique event URLs`);

    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    for (const url of allUrls) {
      const { ev, org } = await fetchEventPage(url);
      if (ev) events.push(ev);
      if (org && !orgMap.has(org.externalId ?? org.name)) orgMap.set(org.externalId ?? org.name, org);
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`eventsize: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
