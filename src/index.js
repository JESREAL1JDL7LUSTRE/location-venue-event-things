import pLimit from 'p-limit';
import chalk from 'chalk';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { launchBrowser, newPage } from './browser.js';
import { parseCli } from './cli.js';
import { loadCache, saveToCache, clearCache, cacheSize } from './cache.js';
import { scrapeListPage } from './scraper/listPage.js';
import { scrapeDetailPage } from './scraper/detailPage.js';

const printVenue = (venue, index, total) => {
  const d = venue.details ?? {};
  console.log(chalk.bold(`${index}/${total}  ${venue.name}`));
  if (d.phone)                   console.log(`   ${chalk.cyan('phone')}        : ${d.phone}`);
  if (d.website)                 console.log(`   ${chalk.cyan('website')}      : ${d.website}`);
  if (d.fullAddress)             console.log(`   ${chalk.cyan('address')}      : ${d.fullAddress}`);
  if (d.locatedIn)               console.log(`   ${chalk.cyan('located in')}   : ${d.locatedIn}`);
  if (d.plusCode)                console.log(`   ${chalk.cyan('plus code')}    : ${d.plusCode}`);
  if (venue.location?.hours)     console.log(`   ${chalk.cyan('hours')}        : ${venue.location.hours}`);
  if (d.price)                   console.log(`   ${chalk.cyan('price')}        : ${d.price}`);
  if (d.reviewCount)             console.log(`   ${chalk.cyan('reviews')}      : ${d.reviewCount}`);
  if (d.featureLabels?.length)   console.log(`   ${chalk.cyan('features')}     : ${d.featureLabels.slice(0, 3).join(' | ')}`);
  if (d.reviewKeywords?.length)  console.log(`   ${chalk.cyan('topics')}       : ${d.reviewKeywords.slice(0, 4).join(' · ')}`);
  if (d.isClaimed !== undefined) console.log(`   ${chalk.cyan('claimed')}      : ${d.isClaimed ? chalk.green('yes') : chalk.yellow('no')}`);
  if (d.ratingDistribution)      console.log(`   ${chalk.cyan('rating dist')} : ${Object.entries(d.ratingDistribution).sort((a,b)=>b[0]-a[0]).map(([s,c])=>`${s}★×${c}`).join(' ')}`);
  if (d.coLocated?.length)       console.log(`   ${chalk.cyan('co-located')}   : ${d.coLocated.map(p=>p.name).slice(0,2).join(', ')}`);
  if (d.reviews?.length)         console.log(`   ${chalk.cyan('review texts')} : ${d.reviews.length} found`);
  if (d.error)                   console.log(`   ${chalk.red('ERROR')}        : ${d.error}`);
  console.log();
};

const saveOutput = async (outputPath, venues) => {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(venues, null, 2));
  console.log(chalk.green(`✔ Saved ${venues.length} venues to ${outputPath}`));
};

const main = async () => {
  const { url, scrolls, concurrency, output, resume } = parseCli();

  if (!resume) {
    console.log(chalk.yellow('--no-resume: clearing cache…'));
    await clearCache();
  }

  const cache = await loadCache();
  const cached = await cacheSize();
  if (cached > 0) console.log(chalk.dim(`Resuming — ${cached} venue(s) already in cache`));

  const browser = await launchBrowser();

  try {
    // ── Phase 1: list page ──────────────────────────────────────────────────
    const listPage = await newPage(browser);
    const venues = await scrapeListPage(listPage, url, scrolls);
    await listPage.close();

    if (venues.length === 0) {
      console.log(chalk.red('No venues found — selectors may need updating.'));
      return;
    }

    const pending = venues.filter((v) => v.url && !cache[v.url]);
    console.log(chalk.bold(`\nFound ${venues.length} venues. ${pending.length} need detail scraping.\n`));

    // ── Phase 2: detail pages (cached + pending) ────────────────────────────
    const limit = pLimit(concurrency);
    let done = cached;

    const enriched = await Promise.all(
      venues.map((venue) => {
        if (!venue.url)        return Promise.resolve(venue);
        if (cache[venue.url])  return Promise.resolve(cache[venue.url]);

        return limit(async () => {
          const result = await scrapeDetailPage(browser, venue).catch((err) => ({
            ...venue,
            details: { error: err.message },
          }));

          await saveToCache(venue.url, result);
          done++;
          printVenue(result, done, venues.length);
          return result;
        });
      }),
    );

    await saveOutput(output, enriched);
  } finally {
    await browser.close();
  }
};

main().catch((err) => {
  console.error(chalk.red(err.stack));
  process.exit(1);
});
