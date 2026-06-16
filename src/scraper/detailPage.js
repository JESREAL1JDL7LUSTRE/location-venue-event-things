import retry from 'p-retry';
import { newPage } from '../browser.js';
import { EXTRACTOR } from './detailExtractor.js';

const DETAIL_DELAY = 2500;

const expandHours = async (page) => {
  try {
    const btn = await page.$('[data-item-id="oh"] button, [jsaction*="openhours"] button');
    if (btn) {
      await btn.click();
      await new Promise((r) => setTimeout(r, 700));
    }
  } catch { /* hours panel absent */ }
};

/* Scroll in 4 passes so lazy-loaded sections (attributes, reviews, similar venues) render */
const fullyLoad = async (page) => {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      const el = document.querySelector('[role="main"]') ?? document.scrollingElement;
      if (el) el.scrollTop += 1500;
    });
    await new Promise((r) => setTimeout(r, 500));
  }
};

const parseCoords = (url) => {
  const m = (url ?? '').match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
};

const scrapeOnce = async (browser, venue) => {
  const page = await newPage(browser);
  try {
    await page.goto(venue.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, DETAIL_DELAY));
    await expandHours(page);
    await fullyLoad(page);
    const details = await page.evaluate(EXTRACTOR);
    const coords  = parseCoords(venue.url);
    return { ...venue, coords, details };
  } finally {
    await page.close();
  }
};

export const scrapeDetailPage = (browser, venue) =>
  retry(() => scrapeOnce(browser, venue), {
    retries: 2,
    onFailedAttempt: ({ attemptNumber, retriesLeft, message }) =>
      console.warn(`  ⚠ [${venue.name}] attempt ${attemptNumber} failed (${retriesLeft} left): ${message}`),
  });
