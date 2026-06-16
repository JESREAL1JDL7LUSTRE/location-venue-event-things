import puppeteer from 'puppeteer';
import { writeFile } from 'node:fs/promises';

// ── Paste any Google Maps search URL here ────────────────────────────────────
const MAPS_URL =
  'https://www.google.com/maps/search/Event+venue/@8.4783009,124.530911,12z/';
// ─────────────────────────────────────────────────────────────────────────────

const SCROLL_ROUNDS = 8;    // how many times to scroll the results panel
const SCROLL_DELAY  = 2000; // ms to wait after each scroll
const DETAIL_DELAY  = 2000; // ms to wait after loading a place detail page
const DETAIL_CONCUR = 3;    // how many detail pages to visit in parallel

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — scrape the search results list
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeListPage(page, url) {
  console.log(`Opening search: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  const PANEL = 'div[role="feed"]';
  await page.waitForSelector(PANEL, { timeout: 30000 });

  console.log('Scrolling to load more results…');
  for (let i = 0; i < SCROLL_ROUNDS; i++) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTop += 1200;
    }, PANEL);
    await new Promise((r) => setTimeout(r, SCROLL_DELAY));
    process.stdout.write(`  scroll ${i + 1}/${SCROLL_ROUNDS}\r`);
  }
  console.log('\nExtracting venue cards…');

  return page.evaluate(() => {
    const PLUS_CODE = /^[A-Z0-9]{4,}\+[A-Z0-9]{2,}/;
    const HOURS     = /^(open|closed)/i;

    return [...document.querySelectorAll('div[role="feed"] > div')].flatMap((card) => {
      const nameEl = card.querySelector('[class*="fontHeadlineSmall"], .qBF1Pd, .NrDZNb');
      const name = nameEl?.textContent?.trim();
      if (!name) return [];

      const ratingLabel = card.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') ?? '';
      const ratingMatch = ratingLabel.match(/([\d.]+)\s+stars/i);
      const rating  = ratingMatch ? parseFloat(ratingMatch[1]) : null;
      const reviews = card.querySelector('[aria-label*="reviews"]')?.textContent?.replace(/[()]/g, '').trim() ?? null;

      const infoLines = [...card.querySelectorAll('[class*="W4Efsd"] > span > span')]
        .map((el) => el.textContent.trim())
        .filter((t) => t && t !== '·');

      let category = null, address = null, plusCode = null, hours = null;
      for (const line of infoLines) {
        if (!category && !PLUS_CODE.test(line) && !HOURS.test(line)) category = line;
        else if (PLUS_CODE.test(line))                                 plusCode = line;
        else if (HOURS.test(line))                                     hours    = line;
        else if (!address)                                             address  = line;
      }

      const url = card.querySelector('a[href*="/maps/place/"]')?.href ?? null;
      return [{ name, rating, reviews, location: { category, address, plusCode, hours }, url }];
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — scrape EVERYTHING from an individual place detail page
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeDetailPage(page, venue) {
  if (!venue.url) return venue;

  try {
    await page.goto(venue.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, DETAIL_DELAY));

    // Expand the weekly hours panel if it exists
    try {
      const hoursToggle = await page.$('[data-item-id="oh"] button, [jsaction*="openhours"] button');
      if (hoursToggle) {
        await hoursToggle.click();
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch { /* hours panel may not exist */ }

    // Scroll the detail sidebar to trigger lazy-loaded sections
    await page.evaluate(() => {
      const panel = document.querySelector('[role="main"]') ?? document.scrollingElement;
      if (panel) panel.scrollTop += 3000;
    });
    await new Promise((r) => setTimeout(r, 800));

    const details = await page.evaluate(() => {
      const clean = (s) => s?.replace(/\s+/g, ' ').trim() ?? null;
      const PLUS_CODE_RE = /^[A-Z0-9]{4,}\+[A-Z0-9]{2,}/;

      // ── Core info items (phone, address, website, plus code, etc.) ──────────
      const infoItems = {};
      for (const el of document.querySelectorAll('[data-item-id]')) {
        const id    = el.getAttribute('data-item-id') ?? '';
        const label = clean(el.getAttribute('aria-label') ?? el.textContent);
        if (!id || !label) continue;

        if (id.startsWith('phone')) {
          infoItems.phone = label.replace(/^Phone:\s*/i, '');
        } else if (id === 'address') {
          infoItems.fullAddress = label.replace(/^Address:\s*/i, '');
        } else if (id === 'authority') {
          infoItems.website = el.href ?? null;
        } else if (id === 'oh') {
          // opening hours button label e.g. "Sunday, 9 AM to 5 PM. Hide open hours for the week"
          infoItems.hoursButtonLabel = label;
        } else if (PLUS_CODE_RE.test(label) || /plus.?code/i.test(label)) {
          infoItems.plusCode = label.replace(/^Plus\s*code:\s*/i, '');
        }
      }

      // Plus code fallback
      if (!infoItems.plusCode) {
        for (const btn of document.querySelectorAll('button[aria-label]')) {
          const label = clean(btn.getAttribute('aria-label'));
          if (PLUS_CODE_RE.test(label ?? '')) { infoItems.plusCode = label; break; }
        }
      }

      // ── "Located in" ────────────────────────────────────────────────────────
      for (const el of document.querySelectorAll('[class*="fontBodyMedium"], [class*="Io6YTe"]')) {
        const t = clean(el.textContent);
        if (t?.toLowerCase().startsWith('located in')) {
          infoItems.locatedIn = t.replace(/^located in:\s*/i, '');
          break;
        }
      }

      // ── Full weekly hours table ──────────────────────────────────────────────
      const hoursTable = {};
      // After expanding, each row is a <tr> or a pair of day/time spans
      for (const row of document.querySelectorAll('table.WgFkxc tr, [class*="y0skZc"] tr')) {
        const cells = [...row.querySelectorAll('td')].map((td) => clean(td.textContent));
        if (cells.length >= 2) hoursTable[cells[0]] = cells.slice(1).join(' ');
      }
      // Fallback: look for day-name + time pairs in aria-labels
      if (Object.keys(hoursTable).length === 0) {
        const DAYS = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;
        for (const el of document.querySelectorAll('[aria-label]')) {
          const label = clean(el.getAttribute('aria-label') ?? '');
          if (DAYS.test(label)) {
            const [day, ...rest] = label.split(',');
            hoursTable[clean(day)] = clean(rest.join(','));
          }
        }
      }
      if (Object.keys(hoursTable).length > 0) infoItems.weeklyHours = hoursTable;

      // ── About / description text ─────────────────────────────────────────────
      const aboutEl = document.querySelector('[class*="PYvSYb"]')
        ?? document.querySelector('div[jslog*="description"]');
      if (aboutEl) infoItems.description = clean(aboutEl.textContent);

      // ── Price level ──────────────────────────────────────────────────────────
      const priceEl = document.querySelector('[aria-label*="Price"]');
      if (priceEl) infoItems.price = clean(priceEl.getAttribute('aria-label')).replace(/^Price:\s*/i, '');

      // ── Review count ─────────────────────────────────────────────────────────
      for (const el of document.querySelectorAll('[aria-label]')) {
        const m = (el.getAttribute('aria-label') ?? '').match(/([\d,]+)\s+review/i);
        if (m) { infoItems.reviewCount = parseInt(m[1].replace(/,/g, ''), 10); break; }
      }

      // ── "About" attribute sections (Accessibility, Service options, Amenities…) ──
      const attributeSections = {};
      // Each section has a heading (h2/h3 or bold span) followed by attribute items
      const sectionHeadings = document.querySelectorAll(
        '[class*="iP2t7d"], [class*="fontTitleSmall"], section h2, section h3',
      );
      for (const heading of sectionHeadings) {
        const sectionName = clean(heading.textContent);
        if (!sectionName || sectionName.length > 60) continue;
        const items = [];
        // Collect sibling or child attribute chips/rows
        let sibling = heading.closest('li, div')?.nextElementSibling;
        for (let k = 0; k < 20 && sibling; k++, sibling = sibling.nextElementSibling) {
          const text = clean(sibling.textContent);
          if (!text || text === sectionName) break;
          items.push(text);
        }
        // Also look for child list items
        const childItems = [...(heading.closest('li, div, section')?.querySelectorAll('li, [class*="hpLkke"]') ?? [])]
          .map((li) => clean(li.textContent))
          .filter(Boolean);
        const merged = [...new Set([...items, ...childItems])];
        if (merged.length) attributeSections[sectionName] = merged;
      }
      if (Object.keys(attributeSections).length) infoItems.attributes = attributeSections;

      // ── All accessibility / feature aria-labels (broad sweep) ───────────────
      const featureLabels = [...document.querySelectorAll('[aria-label]')]
        .map((el) => clean(el.getAttribute('aria-label')))
        .filter((s) => s && /wheelchair|accessible|restroom|parking|delivery|dine.?in|takeout|takeaway|outdoor|indoor|service|amenity|amenities/i.test(s))
        .filter((v, i, a) => a.indexOf(v) === i);
      if (featureLabels.length) infoItems.featureLabels = featureLabels;

      // ── Visible reviews ──────────────────────────────────────────────────────
      const reviews = [];
      for (const reviewEl of document.querySelectorAll('[data-review-id], [class*="jJc9Ad"]')) {
        const author   = clean(reviewEl.querySelector('[class*="d4r55"], .X43Kjb')?.textContent);
        const ratingEl = reviewEl.querySelector('[role="img"][aria-label]');
        const ratingM  = (ratingEl?.getAttribute('aria-label') ?? '').match(/([\d.]+)\s+star/i);
        const rating   = ratingM ? parseFloat(ratingM[1]) : null;
        const date     = clean(reviewEl.querySelector('[class*="rsqaWe"]')?.textContent);
        const text     = clean(reviewEl.querySelector('[class*="wiI7pd"]')?.textContent);
        if (author || text) reviews.push({ author, rating, date, text });
      }
      if (reviews.length) infoItems.reviews = reviews;

      // ── All raw text blocks (catch-all for anything missed) ─────────────────
      const rawBlocks = [];
      for (const el of document.querySelectorAll('[class*="rogA2c"] > div, [class*="m6QErb"] > div')) {
        const text = clean(el.textContent);
        if (text && text.length > 2 && text.length < 300) rawBlocks.push(text);
      }
      const uniqueBlocks = [...new Set(rawBlocks)];
      if (uniqueBlocks.length) infoItems.rawInfoBlocks = uniqueBlocks;

      return infoItems;
    });

    return { ...venue, details };
  } catch (err) {
    return { ...venue, details: { error: err.message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
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
    console.log(`Found ${venues.length} venues. Fetching full details…\n`);

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
        const d = v.details ?? {};
        console.log(`${n}/${venues.length}  ${v.name}`);
        if (d.phone)         console.log(`   phone        : ${d.phone}`);
        if (d.website)       console.log(`   website      : ${d.website}`);
        if (d.fullAddress)   console.log(`   address      : ${d.fullAddress}`);
        if (d.locatedIn)     console.log(`   located in   : ${d.locatedIn}`);
        if (d.plusCode)      console.log(`   plus code    : ${d.plusCode}`);
        if (d.price)         console.log(`   price        : ${d.price}`);
        if (d.reviewCount)   console.log(`   reviews      : ${d.reviewCount}`);
        if (d.weeklyHours)   console.log(`   hours        :`, JSON.stringify(d.weeklyHours));
        if (d.featureLabels?.length) console.log(`   features     : ${d.featureLabels.slice(0, 3).join(' | ')}`);
        if (d.reviews?.length)       console.log(`   reviews found: ${d.reviews.length}`);
        if (d.error)         console.log(`   ERROR        : ${d.error}`);
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
