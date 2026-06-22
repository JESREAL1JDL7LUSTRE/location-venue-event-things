import { chromium, type BrowserContext, type Page } from 'playwright';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';
import { db } from '../db/client.js';
import { eventsSearchquery } from '../../drizzle/schema.js';
import { eq, and } from 'drizzle-orm';

const FB_BASE = 'https://www.facebook.com';
const SOURCE_URL = `${FB_BASE}/events/search`;

// Proxy config from env
const PROXY_USER = process.env.DATAIMPULSE_USER ?? '';
const PROXY_PASS = process.env.DATAIMPULSE_PASS ?? '';
const PROXY_HOST = process.env.DATAIMPULSE_HOST ?? 'gw.dataimpulse.com';
const PROXY_PORT = parseInt(process.env.DATAIMPULSE_PORT ?? '823', 10);
const HEADLESS = process.env.FB_HEADLESS !== 'false';

const proxyServer = PROXY_USER ? `http://${PROXY_HOST}:${PROXY_PORT}` : undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, spread: number) => base + Math.random() * spread;

const dismissLoginModal = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    // Remove login gate overlay and restore scrolling
    document.querySelectorAll('[data-testid="dialog_container"], [role="dialog"]').forEach((el) => el.remove());
    document.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.removeAttribute('aria-hidden'));
    document.body.style.overflow = 'auto';
    document.documentElement.style.overflow = 'auto';
  });
};

const humanScroll = async (page: Page, scrolls = 8): Promise<void> => {
  for (let i = 0; i < scrolls; i++) {
    const dist = 400 + Math.random() * 400;
    await page.evaluate((d) => window.scrollBy(0, d), dist);
    await sleep(jitter(800, 600));
  }
};

const extractEventCards = async (page: Page): Promise<Array<Record<string, string>>> => {
  return page.evaluate(() => {
    const cards: Array<Record<string, string>> = [];
    const seen = new Set<string>();

    // FB renders event cards with a specific data structure
    document.querySelectorAll('a[href*="/events/"]').forEach((el) => {
      const link = el as HTMLAnchorElement;
      const href = link.href;
      if (!href || !/\/events\/\d+/.test(href) || seen.has(href)) return;
      seen.add(href);

      const titleEl = link.querySelector('span[class*="x1lliihq"], span[class*="xt0psk2"]');
      const title = titleEl?.textContent?.trim() ?? '';
      if (!title || title.length < 3) return;

      const img = link.querySelector('img');
      const imageUrl = img?.src ?? '';

      const dateEl = link.querySelector('span[class*="x14ctfv"]');
      const dateText = dateEl?.textContent?.trim() ?? '';

      cards.push({ url: href.split('?')[0], name: title, imageUrl, dateText });
    });
    return cards;
  });
};

const parseFbDate = (dateText: string): Date | null => {
  if (!dateText) return null;
  try {
    const d = new Date(dateText);
    if (!isNaN(d.getTime())) return d;
  } catch { /* */ }
  return null;
};

const extractDetailData = async (page: Page, url: string): Promise<{
  description: string; venueData: ScrapedVenue | null; orgData: { name: string; url: string };
}> => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await sleep(jitter(1500, 1000));
  await dismissLoginModal(page);

  return page.evaluate((fbBase: string) => {
    const description = document.querySelector('[data-testid="event-description"]')?.textContent?.trim()
      ?? document.querySelector('[data-ad-preview="message"]')?.textContent?.trim() ?? '';

    const venueEl = document.querySelector('[data-testid="event-venue"]');
    const venueName = venueEl?.querySelector('span')?.textContent?.trim() ?? '';
    const venueData = venueName ? {
      name: venueName,
      city: '',
      country: 'Philippines',
      sourceUrl: url,
    } : null;

    const hostEl = document.querySelector('a[href*="/groups/"], a[href*="/pages/"], a[href*="profile.php"]');
    const orgHref = (hostEl as HTMLAnchorElement)?.href ?? '';
    const orgName = hostEl?.querySelector('span')?.textContent?.trim() ?? '';

    return {
      description,
      venueData: venueData as { name: string; city: string; country: string; sourceUrl: string } | null,
      orgData: { name: orgName, url: orgHref.startsWith('http') ? orgHref : orgHref ? `${fbBase}${orgHref}` : '' },
    };
  }, FB_BASE);
};

export class FacebookEventsScraper extends BaseScraper {
  readonly source = 'facebook_events';

  async run(): Promise<RunResult> {
    // Get active search queries for facebook_events
    const queries = await db.select()
      .from(eventsSearchquery)
      .where(and(eq(eventsSearchquery.source, 'facebook_events'), eq(eventsSearchquery.isActive, true)));

    if (!queries.length) {
      console.log('facebook_events: no active search queries');
      return { source: this.source, created: 0, updated: 0, eventIds: [] };
    }

    const proxyOpts = proxyServer
      ? { server: proxyServer, username: PROXY_USER, password: PROXY_PASS }
      : undefined;

    const browser = await chromium.launch({
      headless: HEADLESS,
      ...(proxyOpts ? { proxy: proxyOpts } : {}),
    });

    const allEvents: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    try {
      const context: BrowserContext = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        ...(proxyOpts ? { proxy: proxyOpts } : {}),
      });
      const page = await context.newPage();

      // Block images, media, fonts to reduce data usage
      await context.route('**/*.{png,jpg,jpeg,gif,webp,mp4,mp3,woff,woff2,ttf,svg}', (route) => route.abort());

      for (const queryObj of queries) {
        const searchUrl = `${SOURCE_URL}?q=${encodeURIComponent(queryObj.query ?? '')}`;
        console.log(`facebook_events: searching "${queryObj.query}"`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await sleep(jitter(2000, 1000));
          await dismissLoginModal(page);
          await humanScroll(page, 8);

          const cards = await extractEventCards(page);
          console.log(`facebook_events: ${cards.length} cards for query "${queryObj.query}"`);

          for (const card of cards) {
            try {
              const detail = await extractDetailData(page, card.url);
              const ev: ScrapedEvent = {
                name: card.name,
                description: detail.description,
                startsAt: parseFbDate(card.dateText),
                url: card.url,
                imageUrl: card.imageUrl,
                externalId: card.url.match(/\/events\/(\d+)/)?.[1] ?? '',
                sourceUrl: SOURCE_URL,
                organizer: detail.orgData.name.substring(0, 255),
                organizerUrl: detail.orgData.url,
                venue: detail.venueData
                  ? { name: detail.venueData.name, city: detail.venueData.city, country: detail.venueData.country, sourceUrl: detail.venueData.sourceUrl }
                  : null,
              };
              allEvents.push(ev);

              if (detail.orgData.name && detail.orgData.url) {
                const orgKey = detail.orgData.url;
                if (!orgMap.has(orgKey)) {
                  orgMap.set(orgKey, { name: detail.orgData.name, sourceUrl: detail.orgData.url, externalId: orgKey });
                }
              }
            } catch (err) {
              console.error(`facebook_events: detail failed ${card.url}:`, err instanceof Error ? err.message : String(err));
            }
            await sleep(jitter(1000, 500));
          }
        } catch (err) {
          console.error(`facebook_events: query failed "${queryObj.query}":`, err instanceof Error ? err.message : String(err));
        }
      }

      await context.close();
    } finally {
      await browser.close();
    }

    console.log(`facebook_events: ${allEvents.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, allEvents);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
