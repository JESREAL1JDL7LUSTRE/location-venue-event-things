import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const BASE_URL = 'https://www.eventalways.com';
const SOURCE_URL = `${BASE_URL}/philippines`;
const MAX_PAGES = 20;

const CATEGORY_URLS = [
  `${BASE_URL}/philippines`,
  `${BASE_URL}/philippines/exhibitions`,
  `${BASE_URL}/philippines/business`,
  `${BASE_URL}/philippines/it-technology`,
  `${BASE_URL}/philippines/education-training`,
  `${BASE_URL}/philippines/arts-entertainment`,
  `${BASE_URL}/philippines/sports`,
  `${BASE_URL}/philippines/music`,
];

const parseDt = (s: string): Date | null => {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  try { return new Date(`${s}+08:00`); } catch { return null; }
};

const extractLdJson = (html: string): Record<string, unknown> | null => {
  const matches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)];
  for (const match of matches) {
    try {
      const data = JSON.parse(match[1]);
      const items: unknown[] = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && typeof item === 'object' && (item as Record<string, unknown>)['@type'] === 'Event') {
          return item as Record<string, unknown>;
        }
      }
    } catch { /* skip */ }
  }
  return null;
};

const parseListingCards = (html: string, sourceUrl: string): Array<Record<string, string>> => {
  const $ = cheerio.load(html);
  const cards: Array<Record<string, string>> = [];
  $('div.result-block[data_id], div.result-block.map_evevent_list_item').each((_, card) => {
    const $card = $(card);
    const externalId = ($card.attr('data_id') ?? '').trim();
    const linkEl = $card.find('h3.title a, h2.title a').first();
    if (!linkEl.length) return;
    const name = linkEl.text().trim();
    const href = linkEl.attr('href') ?? '';
    const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    const imgEl = $card.find('img.lazy, img[data-src]').first();
    const imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';
    const price = $card.find('span.event-item-price').first().text().trim();
    const cat = $card.find('div.event-label span, .event-category span').first().text().trim();

    let startsAtRaw = '';
    const dateBlock = $card.find('div.result-month').first();
    if (dateBlock.length) {
      const day = dateBlock.find('.result-time-date').text().trim();
      const mon = dateBlock.find('.result-time-month').text().trim();
      const yr = dateBlock.find('.result-time-year').text().trim();
      if (day && mon && yr) {
        try {
          const d = new Date(`${day} ${mon} ${yr}`);
          if (!isNaN(d.getTime())) startsAtRaw = d.toISOString().split('T')[0];
        } catch { /* */ }
      }
    }
    cards.push({ externalId, name, url, imageUrl, price, category: cat, startsAtRaw, sourceUrl });
  });
  return cards;
};

const hasNextPage = (html: string, page: number): boolean => {
  const $ = cheerio.load(html);
  return $(`div.pagination a[href="?page=${page + 1}"], .pagination a[href="?page=${page + 1}"]`).length > 0;
};

const buildFromDetail = (html: string, url: string, card: Record<string, string>): { ev: ScrapedEvent | null; org: ScrapedOrganizer | null } => {
  const $ = cheerio.load(html);
  const ld = extractLdJson(html) ?? {};
  const name = ((ld.name as string) ?? card.name ?? '').trim();
  if (!name) return { ev: null, org: null };

  const location = (ld.location as Record<string, unknown>) ?? {};
  const venueName = ((location.name as string) ?? '').trim();
  const addr = (location.address as Record<string, unknown>) ?? {};
  const geo = (location.geo as Record<string, unknown>) ?? {};
  let venue: ScrapedVenue | null = null;
  if (venueName) {
    venue = {
      name: venueName,
      address: (addr.streetAddress as string) ?? '',
      city: (addr.addressLocality as string) ?? '',
      country: (addr.addressCountry as string) || 'Philippines',
      latitude: parseFloat(geo.latitude as string) || null,
      longitude: parseFloat(geo.longitude as string) || null,
      sourceUrl: url,
    };
  }

  const orgLink = $('h3.organizer-name a, .organizer-name a').first();
  const orgName = orgLink.text().trim();
  const orgHref = orgLink.attr('href') ?? '';
  const orgUrl = orgHref.startsWith('http') ? orgHref : `${BASE_URL}${orgHref}`;
  const orgDesc = $('.organizer-desc p, .organizer-description p').first().text().trim();
  let orgExtId = '';
  $('[onclick]').each((_, el) => {
    const m = ($(el).attr('onclick') ?? '').match(/set_event_session\(['"]follow['"],\s*(\d+)\)/);
    if (m) { orgExtId = m[1]; return false; }
  });

  const ev: ScrapedEvent = {
    name,
    description: ((ld.description as string) ?? '').substring(0, 5000),
    startsAt: parseDt((ld.startDate as string) ?? card.startsAtRaw ?? ''),
    endsAt: parseDt((ld.endDate as string) ?? ''),
    url,
    imageUrl: (ld.image as string) || card.imageUrl || '',
    price: card.price ?? '',
    category: card.category ?? '',
    externalId: card.externalId ?? '',
    sourceUrl: card.sourceUrl ?? SOURCE_URL,
    organizer: orgName.substring(0, 255),
    organizerUrl: orgUrl,
    venue,
  };

  const org: ScrapedOrganizer | null = orgName
    ? { name: orgName, externalId: orgExtId, sourceUrl: orgUrl, description: orgDesc.substring(0, 1000) }
    : null;

  return { ev, org };
};

export class EventAlwaysScraper extends BaseScraper {
  readonly source = 'eventalways';

  async run(): Promise<RunResult> {
    const allCards = new Map<string, Record<string, string>>();
    const browser = await chromium.launch({ headless: true });

    try {
      for (const baseUrl of CATEGORY_URLS) {
        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
          const url = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;
          const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
          const page = await context.newPage();
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await page.waitForTimeout(2000);
            const html = await page.content();
            if (html.includes('Just a moment')) {
              console.warn(`eventalways: Cloudflare blocked ${url}`);
              await context.close();
              break;
            }
            const cards = parseListingCards(html, baseUrl);
            for (const card of cards) {
              const key = card.externalId || card.url;
              if (key && !allCards.has(key)) allCards.set(key, card);
            }
            if (!hasNextPage(html, pageNum)) { await context.close(); break; }
          } catch (err) {
            console.error(`eventalways: listing failed ${url}:`, err);
          }
          await context.close();
        }
      }

      console.log(`eventalways: ${allCards.size} unique cards collected`);

      const events: ScrapedEvent[] = [];
      const orgMap = new Map<string, ScrapedOrganizer>();

      for (const card of allCards.values()) {
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
        const page = await context.newPage();
        try {
          await page.goto(card.url, { waitUntil: 'networkidle', timeout: 30_000 });
          await page.waitForTimeout(1500);
          const html = await page.content();
          if (html.includes('Just a moment')) {
            console.warn(`eventalways: blocked on detail ${card.url}`);
            continue;
          }
          const { ev, org } = buildFromDetail(html, card.url, card);
          if (ev) events.push(ev);
          if (org && !orgMap.has(org.name)) orgMap.set(org.name, org);
        } catch (err) {
          console.error(`eventalways: detail failed ${card.url}:`, err);
        } finally {
          await context.close();
        }
      }

      console.log(`eventalways: ${events.length} events, ${orgMap.size} organizers`);
      const evResult = await saveEvents(this.source, events);
      const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
      return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
    } finally {
      await browser.close();
    }
  }
}
