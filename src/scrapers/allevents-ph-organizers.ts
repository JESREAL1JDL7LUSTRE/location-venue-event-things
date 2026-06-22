import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { BaseScraper, type RunResult, type ScrapedOrganizer } from './base.js';
import { saveOrganizers } from './save.js';
import { db } from '../db/client.js';
import { eventsEvent } from '../../drizzle/schema.js';
import { eq, and } from 'drizzle-orm';

const BASE = 'https://allevents.in';
const SOCIAL_RE = /facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com/i;

const fetchHtml = async (url: string, page: import('playwright').Page): Promise<string> => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForTimeout(1000);
  const html = await page.content();
  if (html.includes('Just a moment')) throw new Error(`Cloudflare blocked ${url}`);
  return html;
};

const extractOrgFromEventPage = (html: string): { name: string; url: string } => {
  const $ = cheerio.load(html);
  const a = $('a[href*="/org/"]').first();
  if (!a.length) return { name: '', url: '' };
  const href = a.attr('href') ?? '';
  const orgUrl = href.startsWith('http') ? href : `${BASE}${href}`;
  let name = a.text().trim();
  if (!name) name = a.find('img').first().attr('alt')?.trim() ?? '';
  return { name, url: orgUrl };
};

const extractOrgProfile = (html: string, orgUrl: string): ScrapedOrganizer | null => {
  const $ = cheerio.load(html);
  let name = '';
  for (const sel of ['.org-name', '.organizer-name', '.org-title', 'h1']) {
    const el = $(sel).first();
    if (el.length) { name = el.text().trim(); if (name) break; }
  }
  if (!name) return null;

  let description = '';
  for (const sel of ['.org-description', '.organizer-about', '.about-text', '.bio', '.description']) {
    const el = $(sel).first();
    if (el.length) { description = el.text().trim(); if (description) break; }
  }

  let website = '';
  $('a[href^="http"]').each((_, el) => {
    const href = $(el).attr('href')?.trim() ?? '';
    if (!SOCIAL_RE.test(href) && !href.includes('allevents.in')) {
      website = href;
      return false;
    }
  });

  let facebookUrl = '';
  let instagramUrl = '';
  $('a[href*="facebook.com/"]').first().each((_, el) => { facebookUrl = $(el).attr('href') ?? ''; });
  $('a[href*="instagram.com/"]').first().each((_, el) => { instagramUrl = $(el).attr('href') ?? ''; });

  const parts = orgUrl.replace(/\/$/, '').split('/');
  const externalId = parts[parts.length - 1]?.match(/^\d+$/) ? parts[parts.length - 1] : '';

  return { name, website, description: description.substring(0, 1000), facebookUrl, instagramUrl, externalId, sourceUrl: orgUrl, country: 'PH' };
};

export class AllEventsPHOrganizersScraper extends BaseScraper {
  readonly source = 'allevents_in';

  async run(): Promise<RunResult> {
    // Phase 1: collect org URLs from event detail pages
    const events = await db.select({ id: eventsEvent.id, url: eventsEvent.url })
      .from(eventsEvent)
      .where(and(eq(eventsEvent.source, 'allevents_in'), eq(eventsEvent.organizerUrl, '')));

    console.log(`allevents_ph_organizers: Phase 1 — enriching ${events.length} events`);

    const orgUrls = new Map<string, string>();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
    const page = await context.newPage();

    try {
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (!event.url) continue;
        console.log(`allevents_ph_organizers: [${i + 1}/${events.length}] ${event.url}`);
        try {
          const html = await fetchHtml(event.url, page);
          const { name, url: orgUrl } = extractOrgFromEventPage(html);
          if (orgUrl) {
            await db.update(eventsEvent)
              .set({ organizer: name, organizerUrl: orgUrl })
              .where(eq(eventsEvent.id, event.id));
            orgUrls.set(orgUrl, name);
            console.log(`  → ${orgUrl}`);
          } else {
            console.warn(`  → no org link found`);
          }
        } catch (err) {
          console.error(`  → error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.log(`allevents_ph_organizers: Phase 1 done — ${orgUrls.size} unique orgs`);

      // Phase 2: scrape org profile pages
      console.log(`allevents_ph_organizers: Phase 2 — scraping ${orgUrls.size} org profiles`);
      const organizers: ScrapedOrganizer[] = [];

      for (const [orgUrl, fallbackName] of orgUrls) {
        console.log(`allevents_ph_organizers: org: ${orgUrl}`);
        try {
          const html = await fetchHtml(orgUrl, page);
          const org = extractOrgProfile(html, orgUrl);
          if (org) {
            organizers.push(org);
          } else {
            const parts = orgUrl.replace(/\/$/, '').split('/');
            const externalId = parts[parts.length - 1]?.match(/^\d+$/) ? parts[parts.length - 1] : '';
            const slugName = parts[parts.length - 2]?.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? '';
            organizers.push({ name: fallbackName || slugName || 'Unknown', externalId, sourceUrl: orgUrl, country: 'PH' });
          }
        } catch (err) {
          console.error(`  → error scraping org: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.log(`allevents_ph_organizers: Phase 2 done — ${organizers.length} org records`);
      const orgResult = await saveOrganizers(this.source, organizers);
      return { source: this.source, created: 0, updated: 0, eventIds: [], organizers_created: orgResult.created, organizers_updated: orgResult.updated };
    } finally {
      await context.close();
      await browser.close();
    }
  }
}
