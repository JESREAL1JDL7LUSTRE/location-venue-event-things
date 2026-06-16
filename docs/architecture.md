# Architecture

---

## Overview

The scraper is a two-phase Node.js pipeline. A single Puppeteer browser instance is shared across both phases; each detail page gets its own tab (page) that is opened and closed per venue.

```
CLI args (commander)
       │
       ▼
  src/index.js  ─────────────────── orchestrator
       │
       ├─── Phase 1: List Page
       │         src/scraper/listPage.js
       │         • navigate to search URL
       │         • scroll feed N rounds (lazy-load)
       │         • extract venue cards → [ {name, rating, location, url} ]
       │
       ├─── Cache lookup (src/cache.js)
       │         • skip venues already in cache/progress.json
       │
       └─── Phase 2: Detail Pages  ←── p-limit (concurrency pool)
                 src/scraper/detailPage.js   ← p-retry (2 retries)
                 src/scraper/detailExtractor.js  ← page.evaluate()
                 • navigate to venue URL
                 • expand hours panel
                 • scroll 4× to trigger lazy sections
                 • inject EXTRACTOR fn → extract all fields
                 • save to cache per venue
                 ↓
           output/venues.json
                 ↓
           src/buildMap.js
                 ↓
           output/map.html  (Leaflet + CartoDB dark tiles)
```

---

## Module Responsibilities

### `src/index.js` — Orchestrator

- Parses CLI options via `parseCli()`
- Clears or loads the progress cache
- Launches the shared browser
- Calls `scrapeListPage` → gets venue stubs
- Fans out `scrapeDetailPage` calls through a `p-limit` pool
- Saves enriched venues to the output JSON file
- No extraction logic lives here

### `src/cli.js` — Argument Parser

- Wraps [commander](https://github.com/tj/commander.js) with typed options
- Returns a plain object `{ url, scrolls, concurrency, output, resume }`
- No I/O, no side effects — pure config

### `src/browser.js` — Browser Factory

- Exports `launchBrowser()` and `newPage(browser)`
- Sets a consistent Chrome user-agent to avoid bot fingerprinting
- Launches headless at 1280×900 (matches a typical laptop screen, ensuring Google Maps renders in full desktop layout)
- Single browser instance shared across all pages in a run

### `src/cache.js` — Progress Cache

- Persists completed detail-page results to `cache/progress.json`
- Key: venue URL (stable across runs)
- On resume, cached entries are returned immediately without re-scraping
- `clearCache()` resets on `--no-resume`
- File is written after **each** venue completes (not at the end), so interruptions lose at most one in-progress venue

### `src/scraper/listPage.js` — Phase 1

- Navigates to the Google Maps search URL
- Waits for `div[role="feed"]` to appear
- Scrolls the feed panel `N` times (2-second delay each) to trigger lazy loading
- Extracts all venue cards: name, rating, location stub (category, address, plus code, hours), and the venue's detail page URL
- Returns an array of venue stubs with no I/O side effects

### `src/scraper/detailPage.js` — Phase 2 Orchestrator

- Opens a new page per venue (closed in `finally` to prevent leaks)
- Navigates to the venue URL with `networkidle2` wait
- Expands the hours panel by clicking its button
- Scrolls the sidebar 4 times × 1500px to trigger lazy sections (attributes, reviews, similar venues)
- Injects `EXTRACTOR` via `page.evaluate()` to run extraction in the browser context
- Parses `{ lat, lng }` coordinates directly from the URL
- Wraps `scrapeOnce` in `p-retry` with 2 retries and a descriptive warning on each failure

### `src/scraper/detailExtractor.js` — Browser-Side Extractor

- Exports a single `EXTRACTOR` function that runs **inside the browser** (serialized by Puppeteer)
- Has no access to Node.js APIs — only browser DOM APIs
- All 15 data fields are extracted in one `page.evaluate()` call to minimize round-trips
- See [scraping-internals.md](scraping-internals.md) for selector details

### `src/buildMap.js` — Map Builder

- Reads `src/map-template.html` (the reusable template) and `output/venues.json`
- Replaces the `VENUES_DATA_PLACEHOLDER` token with the JSON data
- Writes to `output/map.html`
- Template and output are **separate files** — rebuilding never corrupts the template

---

## Data Flow

```
Google Maps search page
        │  (Phase 1: scroll + extract)
        ▼
[ venue stub ]  ×  N
  name, rating, location{}, url
        │
        │  (cache check per URL)
        │
        ▼
[ venue detail page ]  ×  N  (concurrency-limited)
  +coords, +details{}
        │
        ▼
cache/progress.json        (written per venue, enables resume)
        │
        ▼
output/venues.json         (written once at end)
        │
        ▼
src/map-template.html  ──►  output/map.html
     (VENUES_DATA_PLACEHOLDER replaced with JSON)
```

---

## Concurrency Model

```
Phase 1: single page, sequential scrolls
         └── blocking — must complete before Phase 2

Phase 2: p-limit pool of size `concurrency` (default 3)
         ├── venue A  → page open → scrape → close → save cache
         ├── venue B  → page open → scrape → close → save cache
         ├── venue C  → page open → scrape → close → save cache
         │                          (next starts when any slot frees)
         └── ...
         └── all complete → writeFile venues.json
```

Each page lifecycle is isolated: `newPage` → `goto` → `evaluate` → `page.close()`. A failure in one venue does not affect others — it logs the error and records `details: { error: "..." }` in the output.

---

## Key Design Decisions

**Why Puppeteer instead of Got+Cheerio?**
Google Maps is a JavaScript-heavy SPA. The search feed and all venue detail content are rendered client-side after the page loads. HTTP-only scrapers (Got/Cheerio/Axios) receive an empty shell. Puppeteer runs a real Chromium instance that executes the page's JS.

**Why a shared browser, per-venue pages?**
Launching a new browser per venue (~300 ms startup each) would add minutes of overhead. Sharing one browser and opening tabs is both faster and more memory-efficient.

**Why `page.evaluate()` for extraction instead of Puppeteer selectors?**
Calling individual `page.$()` / `page.$$()` for each field makes many round-trips over the DevTools protocol (each is async IPC). A single `page.evaluate()` call serializes the entire extraction function, runs it in the browser process, and returns one object. This is 10–50× fewer protocol calls.

**Why separate `detailExtractor.js`?**
The extraction function is pure browser-side JS with no Node.js dependencies. Keeping it in its own file makes it independently testable (paste into DevTools console), reviewable, and avoids mixing Node.js and browser contexts in the same file.

**Why `p-retry` with 2 retries?**
Google Maps occasionally returns incomplete pages (network blip, JS not fully hydrated). A retry after a cold re-navigation almost always succeeds. 2 retries is enough without wasting time on genuinely broken URLs.

**Why file-based cache instead of a database?**
The workload is dozens to low hundreds of venues — well within what a flat JSON file handles comfortably. No dependency on a database server. The cache file is human-readable and easy to inspect or delete.

**Why `src/map-template.html` separate from `output/map.html`?**
If the template and output were the same file, running `npm run map` twice would corrupt it (the placeholder would be gone after the first run). The template is the source of truth; the output is always regenerated from it.

---

## Dependencies

| Package | Version | Role |
|---------|---------|------|
| `puppeteer` | ^25 | Headless Chromium browser control |
| `p-limit` | ^7 | Concurrency pool for detail pages |
| `p-retry` | ^8 | Automatic retry on detail page failures |
| `commander` | ^15 | CLI argument parsing |
| `chalk` | ^5 | Colored terminal output |
| `got` | ^15 | (installed, not currently used by main scraper) |
| `cheerio` | ^1 | (installed, not currently used by main scraper) |

`got` and `cheerio` are from the original HTTP-only prototype and can be removed if not needed.
