const SCROLL_DELAY = 2000;
const PLUS_CODE = /^[A-Z0-9]{4,}\+[A-Z0-9]{2,}/;
const HOURS = /^(open|closed)/i;

const parseInfoLines = (lines) => {
  let category = null, address = null, plusCode = null, hours = null;
  for (const line of lines) {
    if (!category && !PLUS_CODE.test(line) && !HOURS.test(line)) category = line;
    else if (PLUS_CODE.test(line))  plusCode = line;
    else if (HOURS.test(line))      hours    = line;
    else if (!address)              address  = line;
  }
  return { category, address, plusCode, hours };
};

const scrollFeed = async (page, rounds) => {
  const PANEL = 'div[role="feed"]';
  for (let i = 0; i < rounds; i++) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTop += 1200;
    }, PANEL);
    await new Promise((r) => setTimeout(r, SCROLL_DELAY));
    process.stdout.write(`  scroll ${i + 1}/${rounds}\r`);
  }
  process.stdout.write('\n');
};

const extractCards = (page) =>
  page.evaluate(() => {
    const PLUS = /^[A-Z0-9]{4,}\+[A-Z0-9]{2,}/;
    const HRS  = /^(open|closed)/i;

    return [...document.querySelectorAll('div[role="feed"] > div')].flatMap((card) => {
      const name = card.querySelector('[class*="fontHeadlineSmall"], .qBF1Pd, .NrDZNb')?.textContent?.trim();
      if (!name) return [];

      const ratingLabel = card.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') ?? '';
      const ratingMatch = ratingLabel.match(/([\d.]+)\s+stars/i);
      const rating  = ratingMatch ? parseFloat(ratingMatch[1]) : null;
      const reviews = card.querySelector('[aria-label*="reviews"]')?.textContent?.replace(/[()]/g, '').trim() ?? null;

      const lines = [...card.querySelectorAll('[class*="W4Efsd"] > span > span')]
        .map((el) => el.textContent.trim())
        .filter((t) => t && t !== '·');

      let category = null, address = null, plusCode = null, hours = null;
      for (const line of lines) {
        if (!category && !PLUS.test(line) && !HRS.test(line)) category = line;
        else if (PLUS.test(line))  plusCode = line;
        else if (HRS.test(line))   hours    = line;
        else if (!address)         address  = line;
      }

      const url = card.querySelector('a[href*="/maps/place/"]')?.href ?? null;
      return [{ name, rating, reviews, location: { category, address, plusCode, hours }, url }];
    });
  });

export const scrapeListPage = async (page, url, scrollRounds) => {
  console.log(`Opening search: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('div[role="feed"]', { timeout: 30000 });

  console.log(`Scrolling ${scrollRounds} rounds to load results…`);
  await scrollFeed(page, scrollRounds);
  console.log('Extracting venue cards…');

  return extractCards(page);
};
