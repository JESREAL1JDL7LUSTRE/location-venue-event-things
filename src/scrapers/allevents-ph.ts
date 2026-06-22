import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedVenue } from './base.js';
import { saveEvents } from './save.js';

const CITIES = [
  { slug: 'manila', city: 'Manila' },
  { slug: 'davao', city: 'Davao City' },
  { slug: 'cagayan-de-oro', city: 'Cagayan de Oro' },
];

const parseDt = (text: string): Date | null => {
  if (!text) return null;
  try {
    // Format: "Sat, 27 Jun, 2026 - 08:00 PM"
    const cleaned = text.trim().replace(/,\s*(\d{4})\s*-/, ', $1');
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) return d;
  } catch { /* */ }
  return null;
};

const parseCards = (html: string, city: { slug: string; city: string }): ScrapedEvent[] => {
  const $ = cheerio.load(html);
  const events: ScrapedEvent[] = [];

  $('li.event-card').each((_, card) => {
    const $card = $(card);
    const eid = $card.attr('data-eid');
    const link = $card.attr('data-link') ?? '';
    if (!eid || !link) return;

    let title = $card.find('div.title').text().trim();
    if (!title) {
      const img = $card.find('img.banner-img').first();
      title = img.attr('alt')?.trim() ?? '';
    }
    if (!title) return;

    const imageUrl = $card.find('img.banner-img').first().attr('src')?.trim() ?? '';
    const dateText = $card.find('div.date').first().text().trim();
    const venueName = $card.find('div.location').first().text().trim();
    const price = $card.find('span.price').first().text().trim();
    const cleanLink = link.split('?')[0];

    const venue: ScrapedVenue | undefined = venueName
      ? { name: venueName, city: city.city, country: 'PH', sourceUrl: `https://allevents.in/${city.slug}/all` }
      : undefined;

    events.push({
      name: title,
      startsAt: parseDt(dateText),
      url: cleanLink,
      imageUrl,
      price,
      externalId: eid,
      sourceUrl: `https://allevents.in/${city.slug}/all`,
      venue: venue ?? null,
    });
  });

  return events;
};

export class AllEventsPHScraper extends BaseScraper {
  readonly source = 'allevents_in';

  async run(): Promise<RunResult> {
    const allEvents: ScrapedEvent[] = [];
    const browser = await chromium.launch({ headless: true });

    try {
      for (const city of CITIES) {
        const url = `https://allevents.in/${city.slug}/all`;
        console.log(`allevents_ph: fetching ${url}`);
        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        });
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.waitForTimeout(2000);
          const html = await page.content();
          if (html.includes('Just a moment')) {
            console.warn(`allevents_ph: Cloudflare blocked ${url}, skipping`);
            continue;
          }
          const events = parseCards(html, city);
          console.log(`allevents_ph: ${events.length} events from ${city.city}`);
          allEvents.push(...events);
        } catch (err) {
          console.error(`allevents_ph: error scraping ${url}:`, err);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }

    console.log(`allevents_ph: total ${allEvents.length} events`);
    return saveEvents(this.source, allEvents);
  }
}
