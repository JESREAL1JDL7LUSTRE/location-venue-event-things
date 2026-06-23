import got from 'got';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const SOURCE_URL = 'https://www.ticketspice.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', Accept: 'text/html,*/*' };
const DELAY = 1500;

const SEARCH_QUERIES = [
  'site:ticketspice.com event tickets 2026',
  'site:ticketspice.com festival fair registration 2026',
  'site:ticketspice.com Philippines',
  'site:ticketspice.com Asia event 2026',
];

const DATE_FORMATS = [
  /(\w+ \d{1,2},? \d{4})/,  // "October 18, 2026"
];

const SKIP_HOSTS = new Set([
  'www.ticketspice.com', 'signup.ticketspice.com', 'help.ticketspice.com', 'app.ticketspice.com',
]);
const SKIP_DOMAINS = new Set([
  'ticketspice.com', 'webconnex.com', 'webconnex.io', 'google.com', 'apple.com', 'microsoft.com',
  'tiktok.com', 'linkedin.com', 'purchaseprotection.com', 'mapq.st',
]);

const isEventUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('.ticketspice.com')
      && !SKIP_HOSTS.has(parsed.hostname)
      && parsed.pathname.replace(/\//g, '').length > 0;
  } catch { return false; }
};

const cleanUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `https://${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '');
  } catch { return url; }
};

const googleSearchUrls = async (queries: string[]): Promise<Set<string>> => {
  const found = new Set<string>();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const query of queries) {
      const context = await browser.newContext({ userAgent: HEADERS['User-Agent'] });
      const page = await context.newPage();
      try {
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=30`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(1500);
        const links = await page.evaluate(() =>
          [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href)
        );
        for (const link of links) {
          if (typeof link === 'string' && link.includes('.ticketspice.com/') && isEventUrl(link)) {
            found.add(cleanUrl(link));
          }
        }
      } catch (err) {
        console.warn(`ticketspice: Google search error for "${query}":`, err instanceof Error ? err.message : String(err));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return found;
};

const probeSitemap = async (subdomain: string): Promise<string[]> => {
  try {
    const xml = await got(`https://${subdomain}.ticketspice.com/sitemap.xml`, { headers: HEADERS, timeout: { request: 15_000 } }).text();
    return [...xml.matchAll(/<loc>([^<]+ticketspice\.com[^<]+)<\/loc>/g)]
      .map((m) => m[1].trim())
      .filter(isEventUrl)
      .map(cleanUrl);
  } catch { return []; }
};

const og = ($: cheerio.CheerioAPI, prop: string): string => $(`meta[property="${prop}"], meta[name="${prop}"]`).attr('content')?.trim() ?? '';

const parseDates = (text: string): { starts: Date | null; ends: Date | null } => {
  const yearMatch = text.match(/\b(202[5-9]|20[3-9]\d)\b/);
  if (!yearMatch) return { starts: null, ends: null };
  const year = yearMatch[1];
  const dateRe = /(\w+ \d{1,2})(?:\s*[-–]\s*(?:(\w+)\s*)?(\d{1,2}))?,?\s*\d{4}/g;
  for (const m of text.matchAll(dateRe)) {
    try {
      const starts = new Date(`${m[1]}, ${year}`);
      if (isNaN(starts.getTime())) continue;
      let ends: Date | null = null;
      if (m[3]) {
        const endMonth = m[2] ?? m[1].split(' ')[0];
        ends = new Date(`${endMonth} ${m[3]}, ${year}`);
      }
      return { starts, ends };
    } catch { /* skip */ }
  }
  return { starts: null, ends: null };
};

const extractPrice = ($: cheerio.CheerioAPI): string => {
  const text = $.root().text();
  const prices = [...text.matchAll(/\$(\d+(?:\.\d{2})?)/g)]
    .map((m) => parseFloat(m[1]))
    .filter((p) => p >= 5);
  if (prices.length) return `$${Math.min(...prices).toFixed(2)}`;
  if (/\bfree\b/i.test(text)) return 'Free';
  return '';
};

const extractSocialAndWebsite = ($: cheerio.CheerioAPI): { website: string; facebookUrl: string; instagramUrl: string } => {
  let website = '', facebookUrl = '', instagramUrl = '';
  $('a[href^="http"]').each((_, el) => {
    const href = $(el).attr('href')?.trim() ?? '';
    if (!href) return;
    try {
      const host = new URL(href).hostname.toLowerCase().replace(/^www\./, '');
      if (host.includes('facebook.com') && !facebookUrl) facebookUrl = href;
      else if (host.includes('instagram.com') && !instagramUrl) instagramUrl = href;
      else if (!website && !SKIP_DOMAINS.has(host) && !SKIP_DOMAINS.has(host.split('.').slice(-2).join('.'))) {
        website = `https://${new URL(href).hostname}`;
      }
    } catch { /* */ }
    if (website && facebookUrl && instagramUrl) return false;
  });
  return { website, facebookUrl, instagramUrl };
};

const parsePage = ($: cheerio.CheerioAPI, url: string): { ev: ScrapedEvent; org: ScrapedOrganizer } | null => {
  let name = og($, 'og:title');
  if (!name) name = $('h1').first().text().trim();
  for (const suffix of [' | TicketSpice', ' - TicketSpice', ' | Tickets', ' - Tickets', ' | Webconnex']) {
    if (name.endsWith(suffix)) name = name.slice(0, -suffix.length);
  }
  name = name.trim();
  if (!name) return null;

  const pageText = $.root().text();
  const { starts, ends } = parseDates(pageText);
  const parsed = new URL(url);
  const subdomain = parsed.hostname.replace('.ticketspice.com', '');
  const { website, facebookUrl, instagramUrl } = extractSocialAndWebsite($);
  const emailMatch = pageText.match(/[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/);

  const orgName = subdomain.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const externalId = parsed.pathname.replace(/^\/|\/$/g, '');

  const ev: ScrapedEvent = {
    name,
    description: og($, 'og:description') || og($, 'description'),
    startsAt: starts,
    endsAt: ends,
    url,
    imageUrl: og($, 'og:image'),
    price: extractPrice($),
    externalId,
    sourceUrl: SOURCE_URL,
    organizer: orgName,
    organizerUrl: website || `https://${parsed.hostname}`,
    venue: null,
  };

  const org: ScrapedOrganizer = {
    name: orgName,
    website,
    email: emailMatch ? emailMatch[0] : '',
    facebookUrl,
    instagramUrl,
    externalId: subdomain,
    sourceUrl: `https://${parsed.hostname}`,
  };

  return { ev, org };
};

export class TicketSpiceScraper extends BaseScraper {
  readonly source = 'ticketspice';

  async run(): Promise<RunResult> {
    const seedUrls = await googleSearchUrls(SEARCH_QUERIES);
    console.log(`ticketspice: ${seedUrls.size} URLs from Google`);

    // Probe sitemaps for each discovered subdomain
    const subdomains = new Set<string>();
    for (const url of seedUrls) {
      try { subdomains.add(new URL(url).hostname.replace('.ticketspice.com', '')); } catch { /* */ }
    }
    const allUrls = new Set(seedUrls);
    for (const sub of subdomains) {
      const extra = await probeSitemap(sub);
      extra.forEach((u) => allUrls.add(u));
      if (extra.length) await new Promise((r) => setTimeout(r, DELAY));
    }
    console.log(`ticketspice: ${allUrls.size} total URLs after sitemap probing`);

    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    for (const url of allUrls) {
      try {
        const html = await got(url, { headers: HEADERS, timeout: { request: 30_000 } }).text();
        const $ = cheerio.load(html);
        const result = parsePage($, url);
        if (result) {
          events.push(result.ev);
          if (!orgMap.has(result.org.externalId ?? result.org.name)) {
            orgMap.set(result.org.externalId ?? result.org.name, result.org);
          }
        }
      } catch (err) {
        console.error(`ticketspice: fetch failed ${url}:`, err instanceof Error ? err.message : String(err));
      }
      await new Promise((r) => setTimeout(r, DELAY));
    }

    console.log(`ticketspice: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
