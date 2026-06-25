/**
 * Instagram Posts scraper — mirrors veent-event-scraper instagram_posts.py
 *
 * Navigates to Instagram hashtag explore pages as a logged-in user and extracts
 * post captions, URLs, and author handles. Uses Claude Haiku to determine if a
 * post is an event and extract structured fields.
 *
 * SearchQuery setup (source='instagram_posts'):
 *   query = hashtag without # (e.g. 'manilaevents', 'cebuevents')
 *
 * Auth: set IG_COOKIES_FILE (Netscape format from "Cookie Editor" extension)
 *   default: www.instagram.com_cookies.txt (relative to cwd)
 *
 * Env vars:
 *   IG_COOKIES_FILE    path to Instagram Netscape cookie file
 *   IG_HEADLESS        set to "false" to watch the browser (default: true)
 *   DATAIMPULSE_USER / DATAIMPULSE_PASS — optional residential proxy
 */
import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsSearchquery, eventsEvent } from '../../drizzle/schema.js';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const IG_BASE = 'https://www.instagram.com';
const SOURCE = 'instagram_posts';

const PROXY_USER = process.env.DATAIMPULSE_USER ?? '';
const PROXY_PASS = process.env.DATAIMPULSE_PASS ?? '';
const PROXY_HOST = process.env.DATAIMPULSE_HOST ?? 'gw.dataimpulse.com';
const PROXY_PORT = parseInt(process.env.DATAIMPULSE_PORT ?? '823', 10);
const HEADLESS = process.env.IG_HEADLESS !== 'false';

const NULL_LIKE = new Set([
  '', 'null', 'none', 'n/a', 'na', 'n.a.', 'nil', 'unknown',
  'not available', 'not found', 'not provided', 'not specified',
  '-', '—', '–', 'no', 'false',
]);

const RESALE_RE = /\b(wts|wtb|wtt|lfs|lfb|lft|passaway|pasabay)\b|ticket[s]?\s+(for sale|transfer|resell|selling)|selling\s+ticket/i;
const SLOP_RE = /^(rt @|📢\s*rt|share this|follow us|stream now|streaming now|out now|listen now|pre[-\s]?order now|dropping|available now)/i;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?63[\s.\-]?|(?<!\d))(?:9\d{2}[\s.\-]?\d{3}[\s.\-]?\d{4}|0\d{1,2}[\s.\-]?\d{3,4}[\s.\-]?\d{4})/;
const MIN_CAPTION_LEN = 20;

const REGISTRATION_URL_RE = [
  /https?:\/\/forms\.gle\/[A-Za-z0-9_-]+/i,
  /https?:\/\/docs\.google\.com\/forms\/d\/[A-Za-z0-9_/?=&.\-]+/i,
  /https?:\/\/(?:www\.)?eventbrite\.[a-z]+\/e\/[A-Za-z0-9_\-?=&]+/i,
  /https?:\/\/lu\.ma\/[A-Za-z0-9_\-]+/i,
  /https?:\/\/(?:www\.)?typeform\.com\/to\/[A-Za-z0-9_\-]+/i,
  /https?:\/\/(?:www\.)?jotform\.com\/[A-Za-z0-9_\-/?=&]+/i,
  /https?:\/\/(?:tinyurl\.com|bit\.ly|rb\.gy|ow\.ly|cutt\.ly)\/[A-Za-z0-9_\-]+/i,
];

// ── JS injected into the page ──────────────────────────────────────────────────

const EXTRACT_POSTS_JS = `() => {
    const posts = [];
    const seen  = new Set();

    function isPostHref(href) {
        return /^\/(p|reel|tv)\/[A-Za-z0-9_-]+/.test(href);
    }

    function parseAlt(altText) {
        const text  = (altText || '').trim();
        const byRe  = /^(?:Photo|Video|Reel)\\s+by\\s+@([\\w.]+)\\s+on\\s+Instagram(?::\\s*)?/i;
        const m     = text.match(byRe);
        const handle = m ? '@' + m[1] : null;
        const caption = m ? text.slice(m[0].length).trim() : text;
        return { handle, caption };
    }

    // Strategy 1: article elements (home feed / profile list view)
    for (const article of document.querySelectorAll('article')) {
        let postUrl = null;
        for (const a of article.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (isPostHref(href)) { postUrl = 'https://www.instagram.com' + href; break; }
        }
        if (!postUrl) continue;

        const sc = postUrl.match(/\\/(p|reel|tv)\\/([A-Za-z0-9_-]+)/)?.[2];
        if (!sc || seen.has(sc)) continue;
        seen.add(sc);

        const img = article.querySelector('img[alt]');
        const { handle: altHandle, caption: altCaption } = img
            ? parseAlt(img.getAttribute('alt') || '')
            : { handle: null, caption: '' };

        let authorHandle = null;
        for (const a of article.querySelectorAll('a[href^="/"]')) {
            const href = a.getAttribute('href') || '';
            if (!isPostHref(href) && /^\\/[A-Za-z0-9._]+\\/?$/.test(href)) {
                authorHandle = '@' + href.replace(/\\//g, '');
                break;
            }
        }
        authorHandle = authorHandle || altHandle;

        let caption = altCaption;
        if (!caption) {
            let best = '';
            for (const el of article.querySelectorAll('span, div')) {
                const t = (el.innerText || '').trim();
                if (t.length > best.length && t.length >= 30) best = t;
            }
            caption = best;
        }

        let imageUrl = '';
        if (img) {
            const srcset = img.getAttribute('srcset') || '';
            if (srcset) {
                const last = srcset.trim().split(',').pop().trim().split(/\\s+/)[0];
                if (last && !last.startsWith('data:')) imageUrl = last;
            }
            if (!imageUrl) {
                const src = img.getAttribute('src') || '';
                if (src && !src.startsWith('data:')) imageUrl = src;
            }
        }

        const timeEl = article.querySelector('time[datetime]');
        let mediaType = null;
        if (article.querySelector('video')) mediaType = 'reel';
        else if (img) mediaType = 'photo';

        posts.push({
            post_url:      postUrl,
            shortcode:     sc,
            caption:       caption.substring(0, 2200),
            author_handle: authorHandle,
            media_type:    mediaType,
            timestamp:     timeEl ? timeEl.getAttribute('datetime') : null,
            image_url:     imageUrl,
        });
    }

    // Strategy 2: grid thumbnail links (explore/tags, profile grid)
    if (!posts.length) {
        for (const a of document.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (!isPostHref(href)) continue;
            const m = href.match(/\\/(p|reel|tv)\\/([A-Za-z0-9_-]+)/);
            if (!m) continue;
            const sc = m[2];
            if (seen.has(sc)) continue;
            seen.add(sc);

            const postUrl = 'https://www.instagram.com' + href;
            const img     = a.querySelector('img[alt]');
            const { handle, caption } = img
                ? parseAlt(img.getAttribute('alt') || '')
                : { handle: null, caption: '' };

            let gridImageUrl = '';
            if (img) {
                const srcset = img.getAttribute('srcset') || '';
                if (srcset) {
                    const last = srcset.trim().split(',').pop().trim().split(/\\s+/)[0];
                    if (last && !last.startsWith('data:')) gridImageUrl = last;
                }
                if (!gridImageUrl) {
                    const src = img.getAttribute('src') || '';
                    if (src && !src.startsWith('data:')) gridImageUrl = src;
                }
            }

            posts.push({
                post_url:      postUrl,
                shortcode:     sc,
                caption:       caption.substring(0, 2200),
                author_handle: handle,
                media_type:    a.querySelector('video') ? 'reel' : (img ? 'photo' : null),
                timestamp:     null,
                image_url:     gridImageUrl,
            });
        }
    }

    console.log('[instagram] extracted', posts.length, 'post(s)');
    return posts;
}`;

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, spread: number) => base + Math.random() * spread;
const pause = async (min: number, max: number) => sleep(jitter(min, max - min) * 1000);

const isEligible = (caption: string): boolean => {
  if (!caption || caption.length < MIN_CAPTION_LEN) return false;
  if (RESALE_RE.test(caption)) return false;
  if (SLOP_RE.test(caption)) return false;
  return true;
};

const findRegistrationUrl = (text: string): string => {
  for (const re of REGISTRATION_URL_RE) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return '';
};

const extractContactFallback = (caption: string): { email: string; phone: string } => ({
  email: EMAIL_RE.exec(caption)?.[0]?.trim() ?? '',
  phone: PHONE_RE.exec(caption)?.[0]?.trim() ?? '',
});

const coerceStr = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return NULL_LIKE.has(s.toLowerCase()) ? null : s;
};

const parseIgTimestamp = (raw: string | null | undefined): Date | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
};

// ── LLM structuring ────────────────────────────────────────────────────────────

interface PostStructure {
  is_event: boolean;
  title: string | null;
  start_datetime: string | null;
  venue_name: string | null;
  city_location: string | null;
  organizer_name: string | null;
  organizer_email: string | null;
  organizer_phone: string | null;
  short_description: string | null;
  registration_url: string | null;
}

const buildPrompt = (
  caption: string,
  authorHandle: string | null,
  timestamp: string,
): string =>
  [
    'You are an event-detection and information-extraction engine.',
    'You are given the raw text of an Instagram post caption. Your job has two parts:',
    '1. Decide whether the post is announcing a REAL upcoming live event.',
    '2. If it is, extract the event details.',
    '',
    'Set "is_event" to false if the post is:',
    '  - Selling or reselling tickets (WTS, WTB, passaway, for sale)',
    '  - A fan post, reaction, or general comment about an event',
    '  - Announcing a streaming release, album drop, or digital content',
    '  - A repost with no new event information',
    '  - Too vague or unrelated to live events',
    '',
    'Set "is_event" to true only if the post directly announces an upcoming live event.',
    '',
    'IMPORTANT: if you cannot extract a meaningful event title set is_event to false.',
    '',
    `IMPORTANT — for start_datetime: The post was collected at approximately: ${timestamp}`,
    '  Resolve relative dates: "this Sunday" → next Sunday after the collection date.',
    '  Use ISO 8601 when known (e.g. "2026-05-10T21:00:00"), or a short phrase when partial.',
    '',
    'For organizer_email: ONLY return an email LITERALLY present in the post text. Return JSON null if absent.',
    'For organizer_phone: ONLY return a phone number LITERALLY present. Return JSON null if absent.',
    'For registration_url: return the first link that looks like a registration/sign-up page, or JSON null.',
    '',
    'Respond with ONLY a JSON object, no prose, no markdown:',
    '  "is_event", "title", "start_datetime", "venue_name", "city_location",',
    '  "organizer_name", "organizer_email", "organizer_phone", "short_description", "registration_url"',
    '',
    `Post author: ${authorHandle ?? '(unknown)'}`,
    'Post caption:',
    '"""',
    caption,
    '"""',
    '',
    'Respond with ONLY the JSON object.',
  ].join('\n');

const callLlm = async (
  client: Anthropic,
  caption: string,
  authorHandle: string | null,
  timestamp: string,
): Promise<PostStructure | null> => {
  const prompt = buildPrompt(caption, authorHandle, timestamp);
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return {
      is_event: parsed.is_event === true || String(parsed.is_event).toLowerCase() === 'true',
      title: coerceStr(parsed.title),
      start_datetime: coerceStr(parsed.start_datetime),
      venue_name: coerceStr(parsed.venue_name),
      city_location: coerceStr(parsed.city_location),
      organizer_name: coerceStr(parsed.organizer_name),
      organizer_email: coerceStr(parsed.organizer_email),
      organizer_phone: coerceStr(parsed.organizer_phone),
      short_description: coerceStr(parsed.short_description),
      registration_url: coerceStr(parsed.registration_url),
    };
  } catch (err) {
    console.warn(`[${SOURCE}] LLM structuring failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
};

// ── Browser helpers ────────────────────────────────────────────────────────────

const blockHeavyResources = async (page: Page): Promise<void> => {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') {
      route.abort();
    } else {
      route.continue();
    }
  });
};

const loadCookies = async (context: BrowserContext): Promise<number> => {
  const cookiesFile = process.env.IG_COOKIES_FILE ?? 'www.instagram.com_cookies.txt';
  try {
    const fs = await import('fs/promises');
    const text = await fs.readFile(cookiesFile, 'utf8');
    const cookies: Array<{
      name: string; value: string; domain: string; path: string;
      expires: number; httpOnly: boolean; secure: boolean;
      sameSite: 'Strict' | 'Lax' | 'None';
    }> = [];

    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const parts = t.split('\t');
      if (parts.length < 7) continue;
      const [domain, , path, secure, expiry, name, value] = parts;
      const expires = expiry && expiry !== '0' ? Number(expiry) : -1;
      if (isNaN(expires)) continue;
      cookies.push({
        name, value,
        domain, path: path ?? '/',
        expires,
        httpOnly: false,
        secure: secure.toUpperCase() === 'TRUE',
        sameSite: 'None',
      });
    }

    if (!cookies.length) return 0;
    await context.addCookies(cookies);
    console.log(`[${SOURCE}] loaded ${cookies.length} cookies from ${cookiesFile}`);
    return cookies.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`[${SOURCE}] IG_COOKIES_FILE not found (${cookiesFile}) — may hit login wall`);
    } else {
      console.warn(`[${SOURCE}] failed to load cookies:`, msg);
    }
    return 0;
  }
};

const humanScroll = async (page: Page, rounds?: number): Promise<void> => {
  const r = rounds ?? Math.floor(Math.random() * 5) + 5;
  for (let i = 0; i < r; i++) {
    const px = Math.floor(Math.random() * 400) + 300;
    await page.evaluate(`window.scrollBy(0, ${px})`);
    if (Math.random() < 0.15) {
      await pause(2.0, 4.0);
    } else {
      await pause(1.0, 2.5);
    }
  }
};

interface RawPost {
  post_url: string;
  shortcode: string;
  caption: string;
  author_handle: string | null;
  media_type: string | null;
  timestamp: string | null;
  image_url: string;
}

const fetchForHashtag = async (page: Page, hashtag: string): Promise<RawPost[]> => {
  const tag = hashtag.replace(/^#+/, '');
  const url = `${IG_BASE}/explore/tags/${encodeURIComponent(tag)}/`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`[${SOURCE}] goto attempt ${attempt + 1} failed, retrying...`);
      await pause(3.0, 6.0 + attempt * 2);
    }
  }

  await pause(2.5, 5.0);

  try {
    await page.waitForSelector('article, a[href*="/p/"], a[href*="/reel/"]', { timeout: 20_000 });
  } catch {
    console.warn(`[${SOURCE}] no post elements on ${url} — blocked or empty tag`);
    return [];
  }

  await humanScroll(page);
  await pause(1.5, 3.0);
  await humanScroll(page, Math.floor(Math.random() * 4) + 4);
  await pause(1.0, 2.0);

  const posts = await page.evaluate(EXTRACT_POSTS_JS) as RawPost[];
  console.log(`[${SOURCE}] #${tag}: extracted ${posts.length} post(s)`);
  return posts;
};

// ── Scraper ────────────────────────────────────────────────────────────────────

export class InstagramPostsScraper extends BaseScraper {
  readonly source = SOURCE;

  async run(): Promise<RunResult> {
    const queries = await db
      .select()
      .from(eventsSearchquery)
      .where(and(eq(eventsSearchquery.isActive, true), eq(eventsSearchquery.source, SOURCE)));

    if (!queries.length) {
      console.log(`[${SOURCE}] no active SearchQuery rows with source='${SOURCE}' — add them in the admin`);
      return { source: this.source, created: 0, updated: 0 };
    }

    const proxyOpts = PROXY_USER
      ? { server: `http://${PROXY_HOST}:${PROXY_PORT}`, username: PROXY_USER, password: PROXY_PASS }
      : undefined;

    if (!proxyOpts) {
      console.warn(`[${SOURCE}] no DataImpulse credentials — running without proxy (valid cookies reduce blocking risk)`);
    }

    const browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-sandbox',
      ],
      ...(proxyOpts ? { proxy: proxyOpts } : {}),
    });

    const rawByQuery = new Map<number, RawPost[]>();

    try {
      const context: BrowserContext = await browser.newContext({
        viewport: { width: 1280 + Math.floor(Math.random() * 160), height: 768 + Math.floor(Math.random() * 132) },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'Asia/Manila',
        ...(proxyOpts ? { proxy: proxyOpts } : {}),
      });

      await loadCookies(context);

      for (const sq of queries) {
        const page = await context.newPage();
        await blockHeavyResources(page);
        try {
          const posts = await fetchForHashtag(page, sq.query);
          rawByQuery.set(sq.id, posts);
        } catch (err) {
          console.warn(`[${SOURCE}] #${sq.query} failed:`, err instanceof Error ? err.message : String(err));
          rawByQuery.set(sq.id, []);
        } finally {
          await page.close();
        }
        await pause(3.0, 7.0);
      }

      await context.close();
    } finally {
      await browser.close();
    }

    // Structure posts via LLM + persist
    const client = new Anthropic();
    const collectedAt = new Date().toISOString();
    let totalCreated = 0;
    let totalUpdated = 0;

    for (const sq of queries) {
      const scrapedEvents: ScrapedEvent[] = [];
      const scrapedOrgs: ScrapedOrganizer[] = [];

      for (const raw of rawByQuery.get(sq.id) ?? []) {
        const { post_url, shortcode, caption, author_handle, image_url, timestamp } = raw;

        if (!isEligible(caption)) continue;

        const directReg = findRegistrationUrl(caption);
        const structured = await callLlm(client, caption, author_handle, collectedAt);

        if (structured !== null && !structured.is_event) continue;
        if (structured !== null && !structured.title) continue;

        const fields = structured ?? {
          is_event: true, title: null, start_datetime: null, venue_name: null,
          city_location: null, organizer_name: null, organizer_email: null,
          organizer_phone: null, short_description: null, registration_url: null,
        };

        const llmReg = fields.registration_url ?? '';
        const registrationUrl = directReg || (llmReg && caption.includes(llmReg) ? llmReg : '') || '';

        const contact = extractContactFallback(caption);
        const llmEmail = fields.organizer_email ?? '';
        const organizerEmail = (llmEmail && /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(llmEmail))
          ? llmEmail
          : contact.email;
        const organizerPhone = fields.organizer_phone ?? contact.phone;

        const handle = author_handle ?? '';
        const title = fields.title ?? (handle ? `${handle}: ${caption.slice(0, 80)}` : caption.slice(0, 80));
        const organizerName = fields.organizer_name ?? handle.replace(/^@/, '') ?? '';

        const cityRaw = fields.city_location ?? '';
        const locParts = cityRaw ? cityRaw.split(',').map((p) => p.trim()) : [];
        const city = locParts[0] ?? '';
        const country = locParts.length >= 2 ? locParts[locParts.length - 1] : '';

        const venue: ScrapedVenue | null = fields.venue_name
          ? { name: fields.venue_name, city, country }
          : null;

        const igProfileUrl = handle ? `${IG_BASE}/${handle.replace(/^@/, '')}/` : '';

        scrapedEvents.push({
          name: title.substring(0, 255),
          description: fields.short_description ?? caption.substring(0, 500),
          startsAt: parseIgTimestamp(fields.start_datetime),
          url: post_url,
          imageUrl: image_url || undefined,
          registrationUrl,
          externalId: shortcode,
          sourceUrl: `${IG_BASE}/explore/tags/${encodeURIComponent(sq.query.replace(/^#+/, ''))}/`,
          organizer: organizerName,
          organizerUrl: igProfileUrl,
          venue,
          rawText: caption,
          postDate: parseIgTimestamp(timestamp),
        });

        if (organizerName) {
          scrapedOrgs.push({
            name: organizerName,
            email: organizerEmail,
            phone: organizerPhone,
            instagramUrl: igProfileUrl,
          });
        }

        console.log(`[${SOURCE}] ${post_url.substring(0, 60)} | title=${title.substring(0, 40)} | org=${organizerName.substring(0, 30) || '—'}`);
      }

      if (scrapedOrgs.length) await saveOrganizers(SOURCE, scrapedOrgs);

      const result = await saveEvents(SOURCE, scrapedEvents);

      if (result.eventIds?.length) {
        await db
          .update(eventsEvent)
          .set({ searchQueryId: sq.id })
          .where(and(inArray(eventsEvent.id, result.eventIds), eq(eventsEvent.source, SOURCE)));
      }

      totalCreated += result.created;
      totalUpdated += result.updated;
      console.log(`[${SOURCE}] #${sq.query}: ${result.created} created, ${result.updated} updated`);
    }

    console.log(`[${SOURCE}] done — ${queries.length} queries, ${totalCreated} created, ${totalUpdated} updated`);
    return { source: this.source, created: totalCreated, updated: totalUpdated };
  }
}
