import got from 'got';
import * as cheerio from 'cheerio';
import type { Element as DOMElement } from 'domhandler';
import { BaseScraper, type RunResult, type ScrapedOrganizer } from './base.js';
import { saveOrganizers } from './save.js';

const HOMEPAGE = 'https://www.racemeister.com/';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EventScraper/1.0)' };
const TIMEOUT = 15_000;

const getSoup = async (url: string): Promise<cheerio.CheerioAPI | null> => {
  try {
    const html = await got(url, { headers: HEADERS, timeout: { request: TIMEOUT } }).text();
    return cheerio.load(html);
  } catch (err) {
    console.warn(`racemeister_partners: could not fetch ${url}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
};

const extractContact = async (baseUrl: string): Promise<{ email?: string; phone?: string; facebookUrl?: string; instagramUrl?: string }> => {
  const contact: Record<string, string> = {};
  const scan = ($: cheerio.CheerioAPI): void => {
    if (!contact.email) {
      $('a[href^="mailto:"]').each((_, el) => {
        const email = ($( el).attr('href') ?? '').replace('mailto:', '').split('?')[0].trim();
        if (email) { contact.email = email; return false; }
      });
    }
    if (!contact.phone) {
      $('a[href^="tel:"]').each((_, el) => {
        const phone = ($( el).attr('href') ?? '').replace('tel:', '').trim();
        if (phone) { contact.phone = phone; return false; }
      });
    }
    if (!contact.facebookUrl) {
      $('a[href*="facebook.com/"]').each((_, el) => {
        contact.facebookUrl = $(el).attr('href') ?? '';
        return false;
      });
    }
    if (!contact.instagramUrl) {
      $('a[href*="instagram.com/"]').each((_, el) => {
        contact.instagramUrl = $(el).attr('href') ?? '';
        return false;
      });
    }
  };

  const $ = await getSoup(baseUrl);
  if ($) scan($);

  try {
    const parsed = new URL(baseUrl);
    const root = `${parsed.protocol}//${parsed.host}`;
    for (const path of ['/contact', '/about']) {
      if (contact.email) break;
      const sub = await getSoup(root + path);
      if (sub) scan(sub);
    }
  } catch { /* ignore */ }

  return contact;
};

export class RacemeisterPartnersScraper extends BaseScraper {
  readonly source = 'racemeister_partners';

  async run(): Promise<RunResult> {
    const $ = await getSoup(HOMEPAGE);
    if (!$) {
      console.error('racemeister_partners: could not load homepage');
      return { source: this.source, created: 0, updated: 0, eventIds: [] };
    }

    // Find partners section heading
    let container: cheerio.Cheerio<DOMElement> | null = null;
    $('h2, h3, h4, h5, h6').each((_, el) => {
      if (/partner/i.test($(el).text())) {
        let parent = $(el).parent();
        if (!parent.find('a').length) parent = parent.parent();
        container = parent;
        return false;
      }
    });
    const searchRoot = container ?? $.root();

    const seenNames = new Set<string>();
    const partners: Array<{ name: string; url: string }> = [];

    searchRoot.find('a[href]').each((_, el) => {
      const img = $(el).find('img').first();
      if (!img.length) return;
      const name = (img.attr('title') || img.attr('alt') || '').trim();
      const href = ($(el).attr('href') ?? '').trim();
      if (!name || !href || href.startsWith('#')) return;
      if (seenNames.has(name.toLowerCase())) return;
      seenNames.add(name.toLowerCase());
      partners.push({ name, url: href });
    });

    console.log(`racemeister_partners: ${partners.length} partners found`);

    const organizers: ScrapedOrganizer[] = [];
    for (const p of partners) {
      const org: ScrapedOrganizer = {
        name: p.name,
        externalId: p.name.toLowerCase().replace(/\s+/g, '-'),
        sourceUrl: HOMEPAGE,
      };
      if (p.url.includes('facebook.com')) {
        org.facebookUrl = p.url;
      } else if (p.url.includes('instagram.com')) {
        org.instagramUrl = p.url;
      } else {
        org.website = p.url;
        try {
          const contact = await extractContact(p.url);
          org.email = contact.email;
          org.phone = contact.phone;
          org.facebookUrl = contact.facebookUrl;
          org.instagramUrl = contact.instagramUrl;
        } catch { /* skip */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      organizers.push(org);
    }

    console.log(`racemeister_partners: ${organizers.length} organizers`);
    const orgResult = await saveOrganizers(this.source, organizers);
    return { source: this.source, created: 0, updated: 0, eventIds: [], organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
