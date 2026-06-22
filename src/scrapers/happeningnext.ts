import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { chromium } from 'playwright';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const LISTING_URL = 'https://happeningnext.com/city/ph~cagayan-de-oro~09/';
const SOURCE_URL = 'https://happeningnext.com/city/ph~cagayan-de-oro~09/';

const parseDt = (s: string): Date | null => {
  if (!s) return null;
  try { return new Date(s); } catch { return null; }
};

const extractFbIdFromAvatar = (src: string): string => {
  // graph.facebook.com/<username-or-id>/picture
  const m = src.match(/graph\.facebook\.com\/([^/]+)\/picture/);
  return m ? m[1] : '';
};

const cardToEvent = ($: cheerio.CheerioAPI, el: Element, orgMap: Map<string, ScrapedOrganizer>): ScrapedEvent | null => {
  const $el = $(el);
  const name = $el.find('.event-item__title, h3, h4').first().text().trim();
  if (!name) return null;

  const href = $el.find('a[href]').first().attr('href') ?? '';
  const url = href.startsWith('http') ? href : href ? `https://happeningnext.com${href}` : '';
  const externalIdMatch = url.match(/\/event\/([^/?]+)/);
  const externalId = externalIdMatch ? externalIdMatch[1] : '';

  const imageUrl = $el.find('img').first().attr('src') ?? '';
  const dateText = $el.find('[class*="date"], time').first().attr('datetime') ?? $el.find('[class*="date"], time').first().text().trim();
  const venueName = $el.find('[class*="venue"], [class*="location"]').first().text().trim();
  const price = $el.find('[class*="price"]').first().text().trim();

  const orgImg = $el.find('img[src*="graph.facebook.com"]').first();
  if (orgImg.length) {
    const src = orgImg.attr('src') ?? '';
    const fbId = extractFbIdFromAvatar(src);
    const orgName = orgImg.attr('alt')?.trim() ?? fbId;
    if (fbId && orgName && !orgMap.has(fbId)) {
      const fbUrl = /^\d+$/.test(fbId)
        ? `https://www.facebook.com/profile.php?id=${fbId}`
        : `https://www.facebook.com/${fbId}`;
      orgMap.set(fbId, { name: orgName, externalId: fbId, facebookUrl: fbUrl, sourceUrl: SOURCE_URL });
    }
  }

  let venue: ScrapedVenue | null = null;
  if (venueName) venue = { name: venueName, city: 'Cagayan de Oro', country: 'Philippines', sourceUrl: SOURCE_URL };

  return { name, startsAt: parseDt(dateText), url, imageUrl, price, externalId, sourceUrl: SOURCE_URL, venue };
};

export class HappeningNextCDOScraper extends BaseScraper {
  readonly source = 'happeningnext_cdo';

  async run(): Promise<RunResult> {
    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2000);
      const html = await page.content();

      if (html.includes('Just a moment')) {
        console.warn('happeningnext_cdo: Cloudflare blocked listing page');
      } else {
        const $ = cheerio.load(html);
        $('.event-item.card, [class*="event-card"], article').each((_, el) => {
          const ev = cardToEvent($, el, orgMap);
          if (ev) events.push(ev);
        });
        console.log(`happeningnext_cdo: ${events.length} events from listing`);

        // Enrich organizer info from detail pages
        for (const ev of events.slice(0, 20)) {
          if (!ev.url) continue;
          try {
            await page.goto(ev.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await page.waitForTimeout(1500);
            const detailHtml = await page.content();
            const $d = cheerio.load(detailHtml);
            const orgImg = $d('img[src*="graph.facebook.com"]').first();
            if (orgImg.length) {
              const src = orgImg.attr('src') ?? '';
              const fbId = extractFbIdFromAvatar(src);
              const orgName = orgImg.attr('alt')?.trim() ?? fbId;
              if (fbId && orgName && !orgMap.has(fbId)) {
                const fbUrl = /^\d+$/.test(fbId)
                  ? `https://www.facebook.com/profile.php?id=${fbId}`
                  : `https://www.facebook.com/${fbId}`;
                orgMap.set(fbId, { name: orgName, externalId: fbId, facebookUrl: fbUrl, sourceUrl: SOURCE_URL });
              }
            }
          } catch { /* skip detail errors */ }
        }
      }
      await context.close();
    } finally {
      await browser.close();
    }

    const organizers = [...orgMap.values()];
    console.log(`happeningnext_cdo: ${events.length} events, ${organizers.length} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, organizers);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
