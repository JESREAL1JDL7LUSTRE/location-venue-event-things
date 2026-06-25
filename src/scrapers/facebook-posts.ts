/**
 * Facebook Posts scraper — mirrors veent-event-scraper facebook_posts.py
 *
 * Navigates to FB group/page URLs or keyword searches and extracts unstructured
 * posts. Uses the Anthropic API (claude-haiku) to determine if a post is an
 * event and extract structured fields.
 *
 * SearchQuery.query (source='facebook_posts') can be:
 *   https://www.facebook.com/groups/123456789   — public group
 *   https://www.facebook.com/somepage           — public page
 *   events cebu                                  — keyword → /search/posts?q=...
 *
 * Auth: set FB_COOKIES_FILE (Netscape or JSON cookie export) or
 *       ACC_EMAIL / ACC_PASSWORD for credential login.
 */
import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsSearchquery, eventsEvent } from '../../drizzle/schema.js';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const FB_BASE = 'https://www.facebook.com';
const SOURCE = 'facebook_posts';
const MAX_POSTS_PER_QUERY = 15;

const PROXY_USER = process.env.DATAIMPULSE_USER ?? '';
const PROXY_PASS = process.env.DATAIMPULSE_PASS ?? '';
const PROXY_HOST = process.env.DATAIMPULSE_HOST ?? 'gw.dataimpulse.com';
const PROXY_PORT = parseInt(process.env.DATAIMPULSE_PORT ?? '823', 10);
const HEADLESS = process.env.FB_HEADLESS !== 'false';

const NULL_LIKE = new Set([
  '', 'null', 'none', 'n/a', 'na', 'n.a.', 'nil', 'unknown',
  'not available', 'not found', 'not provided', 'not specified',
  '-', '—', '–', 'no', 'false',
]);

// ── Pre-filter regexes ─────────────────────────────────────────────────────────

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

// ── Browser JS injection strings ───────────────────────────────────────────────

const DISMISS_MODAL_JS = `() => {
  document.querySelectorAll('[data-testid="dialog_container"],[role="dialog"]').forEach(el => el.remove());
  document.querySelectorAll('[aria-hidden="true"]').forEach(el => el.removeAttribute('aria-hidden'));
  document.body.style.overflow = 'auto';
  document.documentElement.style.overflow = 'auto';
}`;

const EXPAND_SEE_MORE_JS = `() => {
  function humanClick(el) {
    if (!el || el.offsetParent === null) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.random() * rect.width;
    const y = rect.top + Math.random() * rect.height;
    for (const type of ['mouseover','mousedown','mouseup','click']) {
      el.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, clientX:x, clientY:y}));
    }
  }
  const candidates = [];
  for (const el of document.querySelectorAll('div[dir="auto"] span, div[dir="auto"] div')) {
    const txt = (el.innerText||el.textContent||'').trim();
    if (/^see more$/i.test(txt) && el.offsetParent !== null) candidates.push(el);
  }
  candidates.forEach(el => humanClick(el));
  return candidates.length;
}`;

const CLICK_RECENT_FILTER_JS = `() => {
  function humanClick(el) {
    if (!el || el.offsetParent === null) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.random() * rect.width;
    const y = rect.top + Math.random() * rect.height;
    for (const type of ['mouseover','mousedown','mouseup','click']) {
      el.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, clientX:x, clientY:y}));
    }
  }
  const direct = document.querySelector('[aria-label="Recent posts"],[aria-label="Recent"]');
  if (direct) { humanClick(direct); return true; }
  for (const el of document.querySelectorAll('[role="tab"],[role="button"]')) {
    const txt = (el.innerText||'').trim();
    if (/^recent\\s*(posts)?$/i.test(txt)) { humanClick(el); return true; }
  }
  return false;
}`;

const CLICK_SEE_MORE_RESULTS_JS = `() => {
  function humanClick(el) {
    if (!el || el.offsetParent === null) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.random() * rect.width;
    const y = rect.top + Math.random() * rect.height;
    for (const type of ['mouseover','mousedown','mouseup','click']) {
      el.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, clientX:x, clientY:y}));
    }
  }
  let clicked = 0;
  for (const el of document.querySelectorAll('[role="button"],button')) {
    const txt = (el.innerText||'').trim();
    if (!/^(see more results|see more posts|more results|see more)$/i.test(txt)) continue;
    if (el.closest('div[dir="auto"]')) continue;
    humanClick(el); clicked++;
  }
  return clicked;
}`;

const EXTRACT_POSTS_JS = `() => {
  const MIN_CAPTION_LEN = 20;
  const GFORM_PATTERNS = [
    /https?:\\/\\/forms\\.gle\\/[A-Za-z0-9_-]+/i,
    /https?:\\/\\/docs\\.google\\.com\\/forms\\/d\\/[A-Za-z0-9_\\/?=&.-]+/i,
    /https?:\\/\\/(?:tinyurl\\.com|bit\\.ly|rb\\.gy|ow\\.ly|cutt\\.ly)\\/[A-Za-z0-9_-]+/i,
  ];

  function isPostHref(href) {
    if (!href || /\\/photo[\\/?]/.test(href) || /\\/media\\//.test(href)) return false;
    return (
      /\\/(posts|permalink)\\//.test(href) ||
      /\\/groups\\/[^/]+\\/(posts|permalink)\\//.test(href) ||
      /story\\.php\\?/.test(href) ||
      /[?&](post_id|story_fbid)=\\d+/.test(href) ||
      /\\/videos\\/\\d/.test(href)
    );
  }

  function toAbsolute(href) {
    return href.startsWith('http') ? href : 'https://www.facebook.com' + href;
  }

  function findPostUrl(card) {
    const timeEl = card.querySelector('time[datetime],abbr[data-utime]');
    if (timeEl) {
      const a = timeEl.closest('a[href]');
      if (a) {
        const href = a.getAttribute('href')||'';
        if (!href.startsWith('#')) return toAbsolute(href);
      }
      let node = timeEl.parentElement;
      for (let i=0; i<12; i++) {
        if (!node || node===document.body) break;
        const dh = node.getAttribute('data-href')||'';
        if (dh && isPostHref(dh)) return toAbsolute(dh);
        const rl = node.getAttribute('href')||'';
        if (rl && isPostHref(rl)) return toAbsolute(rl);
        node = node.parentElement;
      }
    }
    for (const a of card.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href')||'';
      if (isPostHref(href)) return toAbsolute(href);
    }
    return null;
  }

  function findAuthorName(card) {
    const headingLink = card.querySelector('h2 a,h3 a,h4 a') || card.querySelector('strong a,span strong');
    if (headingLink) {
      const txt = (headingLink.innerText||headingLink.textContent||'').trim();
      if (txt) return txt.split('\\n')[0].trim();
    }
    return null;
  }

  function findRegistrationLinks(card, captionText) {
    const found = new Set();
    for (const a of card.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href')||'';
      let target = href;
      const m = href.match(/l\\.facebook\\.com\\/l\\.php\\?u=([^&]+)/i);
      if (m) { try { target = decodeURIComponent(m[1]); } catch {} }
      for (const re of GFORM_PATTERNS) {
        const hit = target.match(re);
        if (hit) found.add(hit[0]);
      }
    }
    for (const re of GFORM_PATTERNS) {
      const hit = (captionText||'').match(re);
      if (hit) found.add(hit[0]);
    }
    return [...found];
  }

  function findPostCaption(card) {
    const dirDivs = [...card.querySelectorAll('div[dir="auto"]')];
    if (dirDivs.length) {
      const texts = dirDivs.map(el=>(el.innerText||'').trim()).filter(t=>t.length>=MIN_CAPTION_LEN);
      if (texts.length) return texts.sort((a,b)=>b.length-a.length)[0];
    }
    return (card.innerText||'').trim();
  }

  function hashCaption(str) {
    let h = 5381;
    const s = str.substring(0,150);
    for (let i=0; i<s.length; i++) { h = ((h<<5)+h)^s.charCodeAt(i); h|=0; }
    return Math.abs(h).toString(16).padStart(8,'0');
  }

  function findPostContainerFromNode(el) {
    const baseLen = (el.innerText||'').trim().length;
    const minLen = Math.max(200, baseLen+20);
    let node = el.parentElement;
    for (let i=0; i<25; i++) {
      if (!node || node===document.body) break;
      if (node.tagName==='DIV' && (node.innerText||'').trim().length>=minLen) return node;
      node = node.parentElement;
    }
    return null;
  }

  const seen = new Set(), seenCards = new WeakSet(), seenCaptions = new Set(), posts = [];

  for (const textEl of document.querySelectorAll('div[dir="auto"]')) {
    if ((textEl.innerText||'').trim().length < MIN_CAPTION_LEN) continue;
    const card = findPostContainerFromNode(textEl);
    if (!card || seenCards.has(card)) continue;
    seenCards.add(card);

    const rawCaption = findPostCaption(card);
    if (rawCaption.length < MIN_CAPTION_LEN) continue;

    const captionPrefix = rawCaption.substring(0,200);
    if (seenCaptions.has(captionPrefix)) continue;
    seenCaptions.add(captionPrefix);

    const realHref = findPostUrl(card);
    const href = realHref || ('https://www.facebook.com/fbpost/posts/synth_' + hashCaption(rawCaption));
    const dedupeKey = href.replace(/[?#].*$/, '');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    posts.push({
      post_url: href,
      author_name: findAuthorName(card),
      raw_caption: rawCaption.substring(0,2000),
      raw_links: findRegistrationLinks(card, rawCaption),
      post_date_raw: (() => {
        const t = card.querySelector('time[datetime]');
        return t ? t.getAttribute('datetime') : null;
      })(),
    });
  }
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

const postExternalId = (postUrl: string): string => {
  const after = postUrl.split('facebook.com/').pop()?.replace(/^\/+|\/+$/g, '') ?? postUrl.slice(-40);
  return after.replace(/\//g, '_') || postUrl.slice(-40);
};

const normalizeTitle = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

const titlesAreNearDuplicates = (a: string, b: string, threshold = 0.75): boolean => {
  const wa = new Set(a.split(' ').filter(Boolean));
  const wb = new Set(b.split(' ').filter(Boolean));
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) { if (wb.has(w)) shared++; }
  if (shared < 4) return false;
  return shared / (wa.size + wb.size - shared) >= threshold;
};

const parsePostDate = (raw: string | null | undefined): Date | null => {
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

const buildPostPrompt = (
  rawCaption: string,
  authorName: string | null,
  timestamp: string,
  rawLinks: string[],
): string => {
  const linksStr = rawLinks.length
    ? rawLinks.map((u, i) => `  [${i + 1}] ${u}`).join('\n')
    : '  (none)';
  return [
    'You are an event-detection and information-extraction engine.',
    'You are given the raw text of a Facebook post. Your job has two parts:',
    '1. Decide whether the post is announcing a REAL upcoming live event.',
    '2. If it is, extract the event details.',
    '',
    'Set "is_event" to false if the post is:',
    '  - Selling or reselling tickets (WTS, WTB, WTT, passaway, for sale, ticket transfer)',
    '  - A fan post, reaction, or general comment about an event',
    '  - Announcing a streaming release, album drop, or digital content',
    '  - A retweet or quote with no new event information',
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
    `Post author: ${authorName ?? '(unknown)'}`,
    'Post text:',
    '"""',
    rawCaption,
    '"""',
    '',
    'LINKS found in the post:',
    linksStr,
    '',
    'Respond with ONLY the JSON object.',
  ].join('\n');
};

const callLlm = async (
  client: Anthropic,
  rawCaption: string,
  authorName: string | null,
  timestamp: string,
  rawLinks: string[],
): Promise<PostStructure | null> => {
  const prompt = buildPostPrompt(rawCaption, authorName, timestamp, rawLinks);
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

const blockHeavyResources = async (page: Page) => {
  await page.route('**/*.{png,jpg,jpeg,gif,webp,mp4,mp3,woff,woff2,ttf,svg,ico}', (r) => r.abort());
};

const dismissModal = (page: Page) => page.evaluate(DISMISS_MODAL_JS).catch(() => {});

const smartScroll = async (page: Page, knownIds: Set<string>): Promise<void> => {
  const MAX_IDLE = 4;
  const MIN_FRESH = 15;
  let idle = 0;

  for (let i = 0; i < 20; i++) {
    const prevH = await page.evaluate(() => document.body.scrollHeight);
    const prevC = await page.evaluate(() => document.querySelectorAll('div[dir="auto"]').length);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await pause(0.6, 1.0);
    await page.evaluate(CLICK_SEE_MORE_RESULTS_JS).catch(() => {});
    await page.evaluate(EXPAND_SEE_MORE_JS).catch(() => {});

    const newH = await page.evaluate(() => document.body.scrollHeight);
    const newC = await page.evaluate(() => document.querySelectorAll('div[dir="auto"]').length);

    if (newH === prevH && newC === prevC) {
      idle++;
    } else {
      idle = 0;
    }
    if (idle >= MAX_IDLE) break;

    if (knownIds.size > 0) {
      const fresh: number = await page.evaluate(
        (known: string[]) => {
          const isPostHref = (href: string) =>
            /\/(posts|permalink)\//.test(href) ||
            /story\.php\?/.test(href) ||
            /[?&](post_id|story_fbid)=\d+/.test(href);
          const knownSet = new Set(known);
          const counted = new Set<string>();
          let count = 0;
          for (const a of document.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') ?? '';
            if (!isPostHref(href)) continue;
            const id = href.split('facebook.com/').pop()?.replace(/^\/+|\/+$/g, '').replace(/\//g, '_') ?? '';
            if (!id || counted.has(id)) continue;
            counted.add(id);
            if (!knownSet.has(id)) count++;
          }
          return count;
        },
        [...knownIds],
      );
      if (fresh >= MIN_FRESH) break;
    }

    await pause(1.5, 2.5);
  }
};

const navigateToQuery = async (page: Page, query: string): Promise<void> => {
  if (/^https?:\/\//i.test(query)) {
    let url = query.trimEnd().replace(/\/+$/, '');
    if (!/\/groups\//.test(url) && !url.endsWith('/posts')) url += '/posts';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  } else {
    await page.goto(`${FB_BASE}/search/posts?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 40_000,
    });
  }
};

const loadCookies = async (context: BrowserContext): Promise<number> => {
  const cookiesFile = process.env.FB_COOKIES_FILE ?? '';
  if (!cookiesFile) return 0;
  try {
    const fs = await import('fs/promises');
    const text = await fs.readFile(cookiesFile, 'utf8');
    let cookies: Array<{ name: string; value: string; domain: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }> = [];

    if (text.trim().startsWith('# Netscape')) {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const parts = t.split('\t');
        if (parts.length < 7) continue;
        const [domain, , path, secure, expiry, name, value] = parts;
        cookies.push({ name, value, domain, path: path ?? '/', expires: Number(expiry) || -1, secure: secure.toUpperCase() === 'TRUE', sameSite: 'None' });
      }
    } else {
      const raw = JSON.parse(text) as Array<Record<string, unknown>>;
      cookies = raw
        .filter((c) => c.name && c.domain)
        .map((c) => ({
          name: String(c.name), value: String(c.value ?? ''),
          domain: String(c.domain), path: String(c.path ?? '/'),
          expires: Number(c.expirationDate ?? c.expires ?? -1),
          httpOnly: Boolean(c.httpOnly), secure: Boolean(c.secure),
          sameSite: (['Strict', 'Lax', 'None'].includes(String(c.sameSite)) ? String(c.sameSite) : 'None') as 'Strict' | 'Lax' | 'None',
        }));
    }

    if (!cookies.length) return 0;
    await context.addCookies(cookies);
    console.log(`[${SOURCE}] loaded ${cookies.length} cookies from ${cookiesFile}`);
    return cookies.length;
  } catch (err) {
    console.warn(`[${SOURCE}] failed to load FB_COOKIES_FILE:`, err instanceof Error ? err.message : String(err));
    return 0;
  }
};

const loginWithCredentials = async (page: Page): Promise<boolean> => {
  const email = process.env.ACC_EMAIL ?? process.env.FB_EMAIL ?? '';
  const password = process.env.ACC_PASSWORD ?? process.env.FB_PASSWORD ?? '';
  if (!email || !password) return false;

  try {
    const cookies = await page.context().cookies();
    if (cookies.some((c) => c.name === 'c_user')) return true;

    await page.goto(`${FB_BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await pause(2.0, 3.5);
    await dismissModal(page);

    const emailSel = ['#email', 'input[name="email"]', 'input[type="email"]'].find(async (s) => {
      try { await page.waitForSelector(s, { state: 'visible', timeout: 3_000 }); return true; } catch { return false; }
    });
    if (!emailSel) { console.warn(`[${SOURCE}] email field not found`); return false; }

    await page.fill(emailSel, email);
    await pause(0.4, 0.8);
    await page.fill('input[name="pass"], input[type="password"]', password);
    await pause(0.4, 0.8);
    await page.keyboard.press('Enter');

    await page.waitForURL((url) => !url.href.includes('/login'), { timeout: 20_000 }).catch(() => {});
    await pause(2.0, 3.0);

    const loggedIn = (await page.context().cookies()).some((c) => c.name === 'c_user');
    console.log(`[${SOURCE}] credential login ${loggedIn ? 'succeeded' : 'failed'}`);
    return loggedIn;
  } catch (err) {
    console.warn(`[${SOURCE}] login error:`, err instanceof Error ? err.message : String(err));
    return false;
  }
};

const fetchRawPosts = async (
  page: Page,
  query: string,
  knownIds: Set<string>,
  maxPosts: number,
): Promise<Array<{ post_url: string; author_name: string | null; raw_caption: string; raw_links: string[]; post_date_raw: string | null }>> => {
  await navigateToQuery(page, query);
  await pause(3.0, 5.0);
  await dismissModal(page);

  await page.waitForSelector('[role="article"] div[dir="auto"]', { timeout: 12_000 }).catch(() => {});

  if (page.url().includes('/search/posts')) {
    await page.evaluate(CLICK_RECENT_FILTER_JS).catch(() => {});
    await pause(1.0, 2.0);
  }

  await page.evaluate(EXPAND_SEE_MORE_JS).catch(() => {});
  await pause(0.5, 1.0);
  await smartScroll(page, knownIds);
  await dismissModal(page);
  await pause(1.0, 2.0);
  await page.evaluate(EXPAND_SEE_MORE_JS).catch(() => {});
  await pause(0.3, 0.7);

  const raw = await page.evaluate(EXTRACT_POSTS_JS) as Array<{ post_url: string; author_name: string | null; raw_caption: string; raw_links: string[]; post_date_raw: string | null }>;
  console.log(`[${SOURCE}] "${query}": ${raw.length} raw posts extracted`);
  return raw.slice(0, maxPosts);
};

// ── Scraper ────────────────────────────────────────────────────────────────────

export class FacebookPostsScraper extends BaseScraper {
  readonly source = SOURCE;

  async run(): Promise<RunResult> {
    const queries = await db
      .select()
      .from(eventsSearchquery)
      .where(eq(eventsSearchquery.isActive, true));

    if (!queries.length) {
      console.log(`[${SOURCE}] no active search queries`);
      return { source: this.source, created: 0, updated: 0 };
    }

    // Pre-load existing external_ids per query to guide early scroll exit
    const knownIdsByQuery = new Map<number, Set<string>>();
    for (const sq of queries) {
      const rows = await db
        .select({ externalId: eventsEvent.externalId })
        .from(eventsEvent)
        .where(and(eq(eventsEvent.source, SOURCE), eq(eventsEvent.searchQueryId, sq.id)));
      knownIdsByQuery.set(sq.id, new Set(rows.map((r) => r.externalId)));
    }

    const proxyOpts = PROXY_USER
      ? { server: `http://${PROXY_HOST}:${PROXY_PORT}`, username: PROXY_USER, password: PROXY_PASS }
      : undefined;

    const browser = await chromium.launch({ headless: HEADLESS, ...(proxyOpts ? { proxy: proxyOpts } : {}) });
    const rawByQuery = new Map<number, Array<{ post_url: string; author_name: string | null; raw_caption: string; raw_links: string[]; post_date_raw: string | null }>>();

    try {
      const context: BrowserContext = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'Asia/Manila',
        ...(proxyOpts ? { proxy: proxyOpts } : {}),
      });

      const page = await context.newPage();
      await blockHeavyResources(page);

      const cookieCount = await loadCookies(context);
      if (cookieCount === 0) await loginWithCredentials(page);

      for (const sq of queries) {
        try {
          const posts = await fetchRawPosts(page, sq.query, knownIdsByQuery.get(sq.id) ?? new Set(), MAX_POSTS_PER_QUERY);
          rawByQuery.set(sq.id, posts);
        } catch (err) {
          console.warn(`[${SOURCE}] query "${sq.query}" failed:`, err instanceof Error ? err.message : String(err));
          rawByQuery.set(sq.id, []);
        }
        await pause(3.0, 6.0);
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
      const seenTitlesThisBatch = new Set<string>();

      for (const raw of rawByQuery.get(sq.id) ?? []) {
        const { post_url, author_name, raw_caption, raw_links, post_date_raw } = raw;

        if (!isEligible(raw_caption)) continue;

        const directReg = findRegistrationUrl(`${raw_caption} ${raw_links.join(' ')}`);
        const structured = await callLlm(client, raw_caption, author_name, collectedAt, raw_links);

        if (structured !== null && !structured.is_event) continue;
        if (structured !== null && !structured.title) continue;

        const fields = structured ?? {
          is_event: true, title: null, start_datetime: null, venue_name: null,
          city_location: null, organizer_name: null, organizer_email: null,
          organizer_phone: null, short_description: null, registration_url: null,
        };

        const registrationUrl = fields.registration_url ?? directReg;
        const contact = extractContactFallback(raw_caption);
        const organizerEmail = fields.organizer_email ?? contact.email;
        const organizerPhone = fields.organizer_phone ?? contact.phone;
        const title = fields.title ?? (author_name ? `${author_name}: ${raw_caption.slice(0, 80)}` : raw_caption.slice(0, 80));
        const organizerName = fields.organizer_name ?? author_name ?? '';

        const cityRaw = fields.city_location ?? '';
        const locParts = cityRaw ? cityRaw.split(',').map((p) => p.trim()) : [];
        const city = locParts[0] ?? '';
        const country = locParts.length >= 2 ? locParts[locParts.length - 1] : '';

        const venue: ScrapedVenue | null = fields.venue_name
          ? { name: fields.venue_name, city, country }
          : null;

        const externalId = postExternalId(post_url);

        // Within-batch title dedup (mirrors Django's seen_titles_this_batch)
        const normTitle = normalizeTitle(title);
        const isBatchDup = [...seenTitlesThisBatch].some(
          (t) => t === normTitle || titlesAreNearDuplicates(normTitle, t),
        );
        if (isBatchDup) continue;
        seenTitlesThisBatch.add(normTitle);

        const saveUrl = post_url.includes('/fbpost/posts/synth_')
          ? `${FB_BASE}/search/top/?q=${encodeURIComponent(title)}`
          : post_url;

        scrapedEvents.push({
          name: title,
          description: fields.short_description ?? '',
          startsAt: parsePostDate(fields.start_datetime),
          url: saveUrl,
          registrationUrl,
          externalId,
          sourceUrl: sq.query,
          organizer: organizerName,
          venue,
          rawText: raw_caption,
          postDate: parsePostDate(post_date_raw),
        });

        if (organizerName) {
          scrapedOrgs.push({
            name: organizerName,
            email: organizerEmail,
            phone: organizerPhone,
          });
        }
      }

      if (scrapedOrgs.length) await saveOrganizers(SOURCE, scrapedOrgs);

      const result = await saveEvents(SOURCE, scrapedEvents);

      // Link events back to their SearchQuery
      if (result.eventIds?.length) {
        await db
          .update(eventsEvent)
          .set({ searchQueryId: sq.id })
          .where(and(inArray(eventsEvent.id, result.eventIds), eq(eventsEvent.source, SOURCE)));
      }

      totalCreated += result.created;
      totalUpdated += result.updated;
      console.log(`[${SOURCE}] query "${sq.query}": ${result.created} created, ${result.updated} updated`);
    }

    console.log(`[${SOURCE}] done — ${queries.length} queries, ${totalCreated} created, ${totalUpdated} updated`);
    return { source: this.source, created: totalCreated, updated: totalUpdated };
  }
}
