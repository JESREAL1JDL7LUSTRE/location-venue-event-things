import puppeteer from 'puppeteer';
import { writeFile } from 'node:fs/promises';

// ── Paste any Google Maps search URL here ────────────────────────────────────
const MAPS_URL =
  'https://www.google.com/maps/search/Event+venue/@8.4783009,124.530911,12z/';
// ─────────────────────────────────────────────────────────────────────────────

const SCROLL_ROUNDS = 8;   // how many times to scroll the results panel
const SCROLL_DELAY  = 2000; // ms to wait after each scroll

async function scrapeGoogleMaps(url) {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  );

  console.log(`Opening: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait for the results list panel to appear
  const PANEL_SELECTOR = 'div[role="feed"]';
  await page.waitForSelector(PANEL_SELECTOR, { timeout: 30000 });

  // Scroll the panel to load more results
  console.log('Scrolling to load more results…');
  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    await page.evaluate((sel) => {
      const panel = document.querySelector(sel);
      if (panel) panel.scrollTop += 1200;
    }, PANEL_SELECTOR);
    await new Promise((r) => setTimeout(r, SCROLL_DELAY));
    process.stdout.write(`  scroll ${i + 1}/${SCROLL_ROUNDS}\r`);
  }
  console.log('\nDone scrolling. Extracting venues…');

  const venues = await page.evaluate(() => {
    const cards = document.querySelectorAll('div[role="feed"] > div');
    const results = [];

    for (const card of cards) {
      // Name
      const nameEl = card.querySelector('[class*="fontHeadlineSmall"], .qBF1Pd, .NrDZNb');
      const name = nameEl?.textContent?.trim();
      if (!name) continue;

      // Rating
      const ratingEl = card.querySelector('[role="img"][aria-label]');
      const ratingLabel = ratingEl?.getAttribute('aria-label') ?? '';
      const ratingMatch = ratingLabel.match(/([\d.]+)\s+stars/i);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      // Review count
      const reviewEl = card.querySelector('[aria-label*="reviews"]');
      const reviewText = reviewEl?.textContent?.replace(/[()]/g, '').trim() ?? null;

      // Raw info lines
      const infoEls = card.querySelectorAll('[class*="W4Efsd"] > span > span');
      const infoLines = [...infoEls]
        .map((el) => el.textContent.trim())
        .filter((t) => t && t !== '·');

      // Parse info lines into named fields
      const PLUS_CODE = /^[A-Z0-9]{4,}\+[A-Z0-9]{2,}/;
      const HOURS     = /^(open|closed)/i;

      let category = null;
      let address  = null;
      let plusCode = null;
      let hours    = null;

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

      // Google Maps link for this card
      const linkEl = card.querySelector('a[href*="/maps/place/"]');
      const placeUrl = linkEl?.href ?? null;

      results.push({
        name,
        rating,
        reviews: reviewText,
        location: { category, address, plusCode, hours },
        url: placeUrl,
      });
    }

    return results;
  });

  await browser.close();
  return venues;
}

async function main() {
  const venues = await scrapeGoogleMaps(MAPS_URL);

  if (venues.length === 0) {
    console.log('No venues found — selectors may need updating if Google changed their markup.');
    return;
  }

  console.log(`\nFound ${venues.length} venue(s):\n`);
  venues.forEach((v, i) => {
    console.log(`${i + 1}. ${v.name}`);
    if (v.rating)              console.log(`   Rating   : ${v.rating} (${v.reviews})`);
    if (v.location.category)  console.log(`   Category : ${v.location.category}`);
    if (v.location.address)   console.log(`   Address  : ${v.location.address}`);
    if (v.location.plusCode)  console.log(`   Plus code: ${v.location.plusCode}`);
    if (v.location.hours)     console.log(`   Hours    : ${v.location.hours}`);
    if (v.url)                console.log(`   Link     : ${v.url}`);
    console.log();
  });

  await writeFile('output/venues.json', JSON.stringify(venues, null, 2));
  console.log('Saved to output/venues.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
