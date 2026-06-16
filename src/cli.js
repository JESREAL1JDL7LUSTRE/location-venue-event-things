import { Command } from 'commander';

const DEFAULT_URL =
  'https://www.google.com/maps/search/Event+venue/@8.4783009,124.530911,12z/';

export const parseCli = () => {
  const program = new Command()
    .name('venue-scraper')
    .description('Scrape Google Maps venue listings into JSON')
    .option('-u, --url <url>', 'Google Maps search URL', DEFAULT_URL)
    .option('-s, --scrolls <n>', 'Scroll rounds on the search page', '8')
    .option('-c, --concurrency <n>', 'Parallel detail page fetches', '3')
    .option('-o, --output <path>', 'Output JSON file path', 'output/venues.json')
    .option('--no-resume', 'Ignore cache and scrape everything from scratch')
    .parse();

  const opts = program.opts();
  return {
    url: opts.url,
    scrolls: parseInt(opts.scrolls, 10),
    concurrency: parseInt(opts.concurrency, 10),
    output: opts.output,
    resume: opts.resume !== false,
  };
};
