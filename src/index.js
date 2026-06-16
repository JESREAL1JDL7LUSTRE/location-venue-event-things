import puppeteer from 'puppeteer';
import { writeFile } from 'node:fs/promises';

// ── Paste any Google Maps search URL here ────────────────────────────────────
const MAPS_URL =
  'https://www.google.com/maps/search/Event+venue/@8.4783009,124.530911,12z/';
// ─────────────────────────────────────────────────────────────────────────────

const SCROLL_ROUNDS  = 8;    // how many times to scroll the results panel
const SCROLL_DELAY   = 2000; // ms to wait after each scroll
const DETAIL_DELAY   = 1500; // ms to wait after loading a place detail page
const DETAIL_CONCUR  = 3;    // how many detail pages to visit in parallel

async function scrapeListPage(page, url) {
  console.log(`Opening search: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  const PANEL_SELECTOR = 'div[role="feed"]';
  await page.waitForSelector(PANEL_SELECTOR, { timeout: 30000 });

  console.log('Scrolling to load more results…');
  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    await page.evaluate((sel) => {
      const panel = document.querySelector(sel);
      if (panel) panel.scrollTop += 1200;
    }, PANEL_SELECTOR);
    await new Promise((r) => setTimeout(r, SCROLL_DELAY));
    process.stdout.write(`  scroll ${i + 1}/${SCROLL_ROUNDS}\r`);
  }
  console.log('\nExtracting venue cards…');

  return page.evaluate(() => {
    const PLUS_CODE = /^[A-Z0-9]{4,}\+[A-Z0-9]{2,}/;
    const HOURS     = /^(open|closed)/i;

    const cards = document.querySelectorAll('div[role="feed"] > div');
    const results = [];

    for (const card of cards) {
      const nameEl = card.querySelector('[class*="fontHeadlineSmall"], .qBF1Pd, .NrDZNb');
      const name = nameEl?.textContent?.trim();
      if (!name) continue;

      const ratingEl = card.querySelector('[role="img"][aria-label]');
      const ratingLabel = ratingEl?.getAttribute('aria-label') ?? '';
      const ratingMatch = ratingLabel.match(/([\d.]+)\s+stars/i);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      const reviewEl = card.querySelector('[aria-label*="reviews"]');
      const reviews = reviewEl?.textContent?.replace(/[()]/g, '').trim() ?? null;

      const infoEls = card.querySelectorAll('[class*="W4Efsd"] > span > span');
      const infoLines = [...infoEls]
        .map((el) => el.textContent.trim())
        .filter((t) => t && t !== '·');

      let category = null, address = null, plusCode = null, hours = null;
      for (const line of infoLines) {
        if (!category && !PLUS_CODE.test(line) && !HOURS.test(line)) {
          category = line;
        } else if (PLUS_CODE.test(line)) {
          plusCode = line;
        } else if (HOURS.test(line)) {
          hours = line;
        } else if (!address && line) {
          address = line;
        }
      }

      const linkEl = card.querySelector('a[href*="/maps/place/"]');
      const placeUrl = linkEl?.href ?? null;

      results.push({ name, rating, reviews, location: { category, address, plusCode, hours }, url: placeUrl });
    }

    return results;
  });
}

async function scrapeDetailPage(page, venue) {
  if (!venue.url) return venue;

  try {
    await page.goto(venue.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, DETAIL_DELAY));

    const details = await page.evaluate(() => {
      const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
      const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) ?? null;

      // Phone — button with aria-label containing the number
      const phoneEl = document.querySelector('button[data-item-id^="phone"]');
      const phone = phoneEl?.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '').trim() ?? null;

      // Website
      const websiteEl = document.querySelector('a[data-item-id="authority"]');
      const website = websiteEl?.href ?? null;

      // Full address
      const addressEl = document.querySelector('button[data-item-id="address"]');
      const fullAddress = addressEl?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '').trim() ?? null;

      // About / description
      const aboutEl = document.querySelector('[class*="PYvSYb"]') ??
                      document.querySelector('div[jslog*="description"]');
      const about = aboutEl?.textContent?.trim() ?? null;

      // Price level  ($ $$ $$$ $$$$)
      const priceEl = document.querySelector('span[aria-label*="Price"]');
      const price = priceEl?.getAttribute('aria-label')?.replace(/^Price:\s*/i, '').trim() ?? null;

      // Review count (numeric)
      const reviewCountEl = document.querySelector('button[jsaction*="reviewChart"]');
      const reviewCount = reviewCountEl?.textContent?.replace(/[^0-9,]/g, '').trim() ?? null;

      return { phone, website, fullAddress, about, price, reviewCount };
    });

    return { ...venue, details };
  } catch (err) {
    return { ...venue, details: { error: err.message } };
  }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    // ── Phase 1: scrape the search results list ───────────────────────────────
    const listPage = await browser.newPage();
    await listPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    );
    const venues = await scrapeListPage(listPage, MAPS_URL);
    await listPage.close();

    if (venues.length === 0) {
      console.log('No venues found — selectors may need updating.');
      return;
    }
    console.log(`Found ${venues.length} venues. Fetching details…\n`);

    // ── Phase 2: visit each place page for extra details ─────────────────────
    const enriched = [];
    for (let i = 0; i < venues.length; i += DETAIL_CONCUR) {
      const batch = venues.slice(i, i + DETAIL_CONCUR);

      const pages = await Promise.all(
        batch.map(async () => {
          const p = await browser.newPage();
          await p.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          );
          return p;
        }),
      );

      const results = await Promise.all(
        batch.map((venue, j) => scrapeDetailPage(pages[j], venue)),
      );

      await Promise.all(pages.map((p) => p.close()));
      enriched.push(...results);

      results.forEach((v, j) => {
        const n = i + j + 1;
        console.log(`${n}/${venues.length} ${v.name}`);
        if (v.details?.phone)       console.log(`   Phone   : ${v.details.phone}`);
        if (v.details?.website)     console.log(`   Website : ${v.details.website}`);
        if (v.details?.fullAddress) console.log(`   Address : ${v.details.fullAddress}`);
        if (v.details?.hours)       console.log(`   Hours   : ${v.location.hours}`);
        if (v.details?.price)       console.log(`   Price   : ${v.details.price}`);
        if (v.details?.reviewCount) console.log(`   Reviews : ${v.details.reviewCount}`);
        if (v.details?.about)       console.log(`   About   : ${v.details.about.slice(0, 80)}…`);
        console.log();
      });
    }

    await writeFile('output/venues.json', JSON.stringify(enriched, null, 2));
    console.log(`Saved ${enriched.length} venues to output/venues.json`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
