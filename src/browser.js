import puppeteer from 'puppeteer';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const launchBrowser = () =>
  puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
  });

export const newPage = async (browser) => {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  return page;
};
