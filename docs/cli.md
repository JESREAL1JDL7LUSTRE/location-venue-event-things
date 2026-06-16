# CLI Reference

The scraper is driven entirely by command-line flags. All flags are optional — the defaults target CDO event venues.

---

## Synopsis

```bash
node src/index.js [options]
# or
npm start -- [options]
npm run scrape -- [options]
```

---

## Options

### `-u, --url <url>`

**Google Maps search URL** to scrape.

- **Default:** `https://www.google.com/maps/search/Event+venue/@8.4783009,124.530911,12z/`
- Must be a `/search/` URL (not a single place URL).
- Construct by searching on Google Maps, copying the URL from the address bar.

```bash
# CDO wedding venues
npm start -- --url "https://www.google.com/maps/search/Wedding+venue/@8.4783009,124.530911,12z/"

# Manila event halls
npm start -- --url "https://www.google.com/maps/search/Event+hall/@14.5995,120.9842,13z/"

# Shorter alias
npm start -- -u "https://www.google.com/maps/search/..."
```

**Tip:** The `@lat,lng,zoom` suffix in the URL controls where the map is centered and how many results load. A wider zoom (lower number) = fewer, more spread results. A tighter zoom (higher number) = denser local results.

---

### `-s, --scrolls <n>`

**Number of scroll rounds** on the search results feed before extracting cards.

- **Default:** `8`
- Each scroll loads approximately 5–7 new venue cards and waits 2 seconds.
- More scrolls = more venues, longer runtime.

```bash
# Quick test — ~20–30 venues
npm start -- --scrolls 3

# Full sweep — ~80–100 venues (if available in the area)
npm start -- --scrolls 20
```

**Estimating venue count:** `scrolls × 6 ≈ venues` (rough guide).

**Diminishing returns:** Google Maps typically caps visible results at ~120 per search. After that, scrolling continues but no new cards appear. `--scrolls 20` is usually sufficient for any area.

---

### `-c, --concurrency <n>`

**Number of detail pages scraped in parallel.**

- **Default:** `3`
- Each concurrent scrape opens its own Puppeteer page (tab).
- Higher values are faster but increase memory usage and risk of Google rate-limiting.

```bash
# Conservative — slow machines or flaky network
npm start -- --concurrency 1

# Balanced (default)
npm start -- --concurrency 3

# Aggressive — fast machine, good connection
npm start -- --concurrency 5
```

**Memory:** Each Chromium tab uses ~80–150 MB RAM. `concurrency 5` may use ~750 MB peak.

**Rate limiting:** If you see many retry warnings (`⚠ attempt N failed`), reduce concurrency to `1` or `2`.

---

### `-o, --output <path>`

**Output file path** for the scraped JSON.

- **Default:** `output/venues.json`
- The directory is created automatically if it does not exist.
- After scraping, run `npm run map` to rebuild the HTML map from this file.

```bash
# Save to a custom path
npm start -- --output data/cdo-venues-2025.json

# Multiple runs with different search terms
npm start -- --url "...Wedding+venue..." --output output/wedding-venues.json
npm start -- --url "...Convention+center..." --output output/convention-centers.json
```

---

### `--no-resume`

**Ignore the progress cache** and scrape all venues from scratch.

- **Default behavior (without this flag):** Previously scraped venues (stored in `cache/progress.json`) are skipped.
- Use `--no-resume` when: selectors have been updated, you want fresh data, or the cache is stale.

```bash
# Fresh scrape, ignore everything in cache
npm start -- --no-resume

# Fresh scrape to a new output file
npm start -- --no-resume --output output/fresh-venues.json
```

---

## Full Examples

```bash
# Default run — CDO event venues, 8 scrolls, resume from cache
npm start

# Full CDO sweep — more results, slower
npm start -- --scrolls 15 --concurrency 2

# Different city, fresh data
npm start -- \
  --url "https://www.google.com/maps/search/Event+venue/@10.3157,123.8854,13z/" \
  --scrolls 10 \
  --output output/cebu-venues.json \
  --no-resume

# Quick test run — 1 scroll, 1 concurrent, custom output
npm start -- --scrolls 1 --concurrency 1 --output output/test.json
```

---

## Runtime Output

While running, the scraper prints progress to the terminal:

```
Opening search: https://www.google.com/maps/search/...
Scrolling 8 rounds to load results…
  scroll 8/8
Extracting venue cards…

Found 54 venues. 54 need detail scraping.

1/54  Cove Garden Resort
   phone        : 0917 770 7392
   website      : http://www.priderockcdo.com/cove/
   address      : Zone 3, Gusa, Old Road, Cugman, Cagayan De Oro City
   hours        : Open · Closes 5 PM
   reviews      : 291
   topics       : wedding venue 14 · garden wedding 4
   claimed      : yes

2/54  Station 5 Events Place
   ...

✔ Saved 54 venues to output/venues.json
```

`⚠` lines indicate a detail page retry — normal if occasional. Persistent failures result in `details: { error: "..." }` in the output.

---

## Environment Notes

- The scraper runs **headless** (no visible browser window).
- User-agent is set to a standard Chrome string to avoid bot detection.
- Each detail page waits 2.5 seconds after load before extracting, allowing JS-rendered content to settle.
- The `cache/progress.json` file is safe to delete if you want a clean restart without using `--no-resume`.
