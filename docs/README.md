# VenueMap Scraper — Documentation

Google Maps venue scraper for Cagayan de Oro event venues. Two-phase Puppeteer scraper: collects venue cards from a search results page, then enriches each venue with full detail-page data. Outputs structured JSON and a self-contained interactive HTML map.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run the scraper (defaults: CDO event venues, 8 scroll rounds)
npm start

# 3. Build the interactive map from scraped data
npm run map

# 4. Open the map
start output/map.html        # Windows
open output/map.html         # macOS
```

---

## Project Structure

```
node-scraper/
├── src/
│   ├── index.js                  # Main orchestrator — CLI → scrape → save
│   ├── cli.js                    # commander argument parser
│   ├── browser.js                # Puppeteer browser/page factory
│   ├── cache.js                  # Progress cache for resume capability
│   ├── buildMap.js               # Injects JSON data into map template
│   ├── map-template.html         # HTML map source (Leaflet + dark UI)
│   └── scraper/
│       ├── listPage.js           # Phase 1 — scroll & extract search feed cards
│       ├── detailPage.js         # Phase 2 — orchestrate per-venue detail scrape
│       └── detailExtractor.js    # Browser-side DOM extraction function
├── output/
│   ├── venues.json               # Final scraped dataset
│   └── map.html                  # Built interactive map (open in browser)
├── cache/
│   └── progress.json             # Resume cache — keyed by venue URL
└── docs/                         # ← You are here
    ├── README.md
    ├── cli.md
    ├── architecture.md
    ├── data-schema.md
    ├── map.md
    └── scraping-internals.md
```

---

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm start` | `node src/index.js` | Run scraper with default options |
| `npm run scrape` | `node src/index.js` | Alias for `npm start` |
| `npm run map` | `node src/buildMap.js` | Build `output/map.html` from current `venues.json` |

Pass CLI flags after `--`:

```bash
npm start -- --url "https://..." --scrolls 12 --concurrency 5
```

---

## Requirements

- **Node.js** 18+ (ESM modules, top-level await)
- **Internet connection** during scraping (Google Maps + CDN fonts on the map)
- ~300 MB disk for Puppeteer's bundled Chromium (installed automatically with `npm install`)

---

## Typical Workflow

```
npm start                    # scrape → cache/progress.json + output/venues.json
# ... interrupted? just run again, cached venues are skipped
npm start                    # resumes from where it stopped
npm run map                  # rebuild output/map.html
start output/map.html        # view results
```

Full re-scrape (ignore cache):

```bash
npm start -- --no-resume
```

---

## Documentation Index

| File | Contents |
|------|----------|
| [cli.md](cli.md) | All CLI flags, defaults, and usage examples |
| [architecture.md](architecture.md) | Module design, data flow, decisions |
| [data-schema.md](data-schema.md) | Full annotated output JSON schema |
| [map.md](map.md) | Interactive map features and rebuild guide |
| [scraping-internals.md](scraping-internals.md) | DOM selectors, extraction logic, known limits |
