import 'dotenv/config';
import { SCRAPERS, getScraper } from './scrapers/registry.js';
import { createScraperRun, markRunStarted, markRunSuccess, markRunFailed, appendLog } from './scrapers/runner.js';

const args = process.argv.slice(2);
const command = args[0];

const runScraper = async (key: string) => {
  const scraper = getScraper(key);
  if (!scraper) {
    console.error(`Unknown scraper: "${key}". Run with --list to see available scrapers.`);
    process.exit(1);
  }

  console.log(`Running scraper: ${key}`);
  const { id: runId } = await createScraperRun(key);
  await markRunStarted(runId, process.pid);

  const logBuffer: string[] = [];
  const flushLog = async () => {
    if (!logBuffer.length) return;
    const lines = logBuffer.splice(0, logBuffer.length).join('\n');
    await appendLog(runId, lines);
  };

  // Override console.log/error to also log to DB
  const origLog = console.log;
  const origError = console.error;
  const flushInterval = setInterval(flushLog, 2000);

  console.log = (...a) => { const line = a.join(' '); logBuffer.push(line); origLog(line); };
  console.error = (...a) => { const line = '[ERROR] ' + a.join(' '); logBuffer.push(line); origError(line); };

  try {
    const result = await scraper.run();
    clearInterval(flushInterval);
    await flushLog();
    await markRunSuccess(runId, result.created, result.updated, result);
    console.log = origLog;
    console.error = origError;
    origLog(`✓ ${key}: ${result.created} created, ${result.updated} updated`);
    return result;
  } catch (err) {
    clearInterval(flushInterval);
    await flushLog();
    const error = err instanceof Error ? err : new Error(String(err));
    await markRunFailed(runId, error);
    console.log = origLog;
    console.error = origError;
    origError(`✗ ${key}: ${error.message}`);
    throw err;
  }
};

const main = async () => {
  if (!command || command === '--list' || command === 'list') {
    console.log('Available scrapers:\n');
    for (const [key, Cls] of Object.entries(SCRAPERS)) {
      const meta = Cls.meta;
      console.log(`  ${key.padEnd(30)} ${meta.label} — ${meta.description}`);
    }
    return;
  }

  if (command === 'scrape') {
    const scraperKey = args[1];
    if (!scraperKey) {
      // Run all scrapers sequentially
      console.log('Running all scrapers...\n');
      const keys = Object.keys(SCRAPERS);
      for (const key of keys) {
        try {
          await runScraper(key);
        } catch {
          console.error(`Scraper ${key} failed, continuing with next...`);
        }
      }
    } else {
      await runScraper(scraperKey);
    }
    return;
  }

  // Legacy Google Maps mode (kept for backwards compatibility)
  if (command === '--mode' && args[1] === 'maps' || !command) {
    // Delegate to the existing google-maps scraper
    await runScraper('google_maps');
    return;
  }

  console.error(`Unknown command: "${command}". Use "scrape [key]" or "--list".`);
  process.exit(1);
};

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
