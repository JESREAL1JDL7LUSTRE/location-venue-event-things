# Scraping Internals

How the scraper extracts data from Google Maps — selectors used, why they work, and known limitations.

---

## Why Puppeteer

Google Maps is a JavaScript SPA. All content — search results, venue details, hours, reviews — is rendered client-side after the initial HTML loads. HTTP-only scrapers (Got, Axios, Cheerio) receive an empty `<div id="app"></div>`. Puppeteer runs a real Chromium instance that executes Google's JavaScript, producing the same DOM a human would see.

---

## Phase 1: List Page

**File:** `src/scraper/listPage.js`

### How results load

Google Maps loads results lazily as the user scrolls the sidebar feed. The feed container is `div[role="feed"]`. Scrolling this element (not `window`) triggers new batch loads.

```js
// Scroll the feed panel, not the window
page.evaluate((sel) => {
  const el = document.querySelector(sel);  // 'div[role="feed"]'
  if (el) el.scrollTop += 1200;
}, PANEL);
```

Each round waits 2 seconds for the network request to complete and cards to render.

### Card extraction

Each card in the feed is a direct child `div` of `div[role="feed"]`.

| Data | Selector | Notes |
|------|----------|-------|
| Name | `[class*="fontHeadlineSmall"], .qBF1Pd, .NrDZNb` | Multiple fallbacks for different Google Maps versions |
| Rating | `[role="img"][aria-label]` → regex `/([\d.]+)\s+stars/i` | The `aria-label` is the reliable data source |
| Detail URL | `a[href*="/maps/place/"]` href | First matching link within the card |
| Info lines | `[class*="W4Efsd"] > span > span` | Text segments separated by `·` separators |

### Info line parsing

The info line text segments are in an unordered list — there is no dedicated `category` or `address` field in the DOM. Parsing uses position and pattern matching:

```
Line 1: category  (first line that is not a plus code, not "open/closed")
Line 2: address   (second line that isn't a plus code or hours)
Plus code: matches /^[A-Z0-9]{4,}\+[A-Z0-9]{2,}/
Hours: matches /^(open|closed)/i
```

---

## Phase 2: Detail Page

**Files:** `src/scraper/detailPage.js`, `src/scraper/detailExtractor.js`

### Page loading sequence

```
page.goto(url, { waitUntil: 'networkidle2' })   // wait for network quiet
await 2500ms                                      // allow JS hydration
expandHours()                                     // click hours toggle button
fullyLoad() × 4 passes                           // scroll to trigger lazy sections
page.evaluate(EXTRACTOR)                          // extract all fields at once
```

### Why `networkidle2` isn't enough

Even after `networkidle2` fires, Google Maps continues rendering UI elements for 1–2 seconds (ratings bar animation, attribute sections, lazy image loads). The 2500ms hard delay is a pragmatic buffer.

### Hours panel expansion

The weekly hours table is hidden behind a "See hours" toggle. Clicking it reveals the full table:

```js
const btn = await page.$('[data-item-id="oh"] button, [jsaction*="openhours"] button');
if (btn) await btn.click();
```

Without this click, `weeklyHours` would be empty for most venues.

### Scroll loading

Several sections only render when they scroll into view:
- Feature attribute sections (Accessibility, Service options)
- Review list (partially)
- "People also search for" carousel
- "At this place" co-location section

Four passes of 1500px scrolling (= 6000px total) loads the full sidebar on most venues.

---

## EXTRACTOR — Selector Reference

The `EXTRACTOR` function runs inside the browser. It has no Node.js access — only DOM APIs.

### Core info (phone, address, website, plus code)

Google Maps uses `data-item-id` as a stable identifier on key info elements:

| `data-item-id` | Field | Source |
|----------------|-------|--------|
| starts with `"phone"` | `phone` | `aria-label` stripped of `"Phone: "` prefix |
| `"address"` | `fullAddress` | `aria-label` stripped of `"Address: "` prefix |
| `"authority"` | `website` | `element.href` (the anchor's real href, not display text) |
| plus code pattern | `plusCode` | `aria-label` if label matches `/^[A-Z0-9]{4,}\+[A-Z0-9]{2,}/` |

Plus code fallback: if not found via `data-item-id`, scan all `button[aria-label]` elements for the pattern.

### Located in

```js
// Matches elements containing "Located in: ..." text
for (const el of document.querySelectorAll('[class*="fontBodyMedium"], [class*="Io6YTe"]')) {
  const t = el.textContent.trim();
  if (t.toLowerCase().startsWith('located in')) { ... }
}
```

### Weekly hours

Two strategies, tried in order:

**Strategy 1 — Hours table:**
```js
// Google Maps renders hours as a <table> with class WgFkxc or y0skZc
for (const row of document.querySelectorAll('table.WgFkxc tr, [class*="y0skZc"] tr')) {
  const cells = row.querySelectorAll('td');  // [day, hours]
}
```

**Strategy 2 — aria-label fallback:**
```js
// Some venues expose hours as aria-labels: "Monday, 8 AM–5 PM"
for (const el of document.querySelectorAll('[aria-label]')) {
  const label = el.getAttribute('aria-label');
  if (/^(monday|tuesday|...)/.test(label)) {
    const [day, ...rest] = label.split(',');
    hoursTable[day] = rest.join(',');
  }
}
```

The `"Copy open hours"` artifact (a button Google injects for clipboard copy) is stripped from all hour values using `cleanHrs()`.

### Description

```js
document.querySelector('[class*="PYvSYb"]') ?? document.querySelector('div[jslog*="description"]')
```

The `PYvSYb` class targets the "From the business" description block. The `jslog*="description"` is a secondary fallback.

### Review count

```js
// Find any aria-label matching "N reviews" or "N,NNN reviews"
const m = (el.getAttribute('aria-label') ?? '').match(/([\d,]+)\s+review/i);
```

### Rating distribution

```js
// aria-labels like "5 stars, 210 reviews" or "3 stars, 12 reviews"
const m = label.match(/^(\d)\s+star[^,]*,\s*([\d,]+)/i);
// → ratingDist[5] = 210
```

### isClaimed

```js
result.isClaimed = ![...document.querySelectorAll('a, button')]
  .some((el) => /claim this business/i.test(el.textContent));
```

If "Claim this business" is present as a link or button text, the listing is unclaimed (`false`).

### Attribute sections

**The critical constraint:** Google Maps uses the same CSS classes (`fontTitleSmall`, `iP2t7d`) for both venue attribute section headings AND map layer control headings ("Map details", "Map tools"). The fix: scope to `[role="main"]` and whitelist known section names.

```js
const KNOWN_ATTR = /^(Accessibility|Service options|Offerings|Planning|Amenities|
                      Highlights|Crowd|Dining options|Children|Payments|
                      Parking|Pets|From the business)/i;

// Scoped to [role="main"] — excludes the map layer controls panel
for (const h of main.querySelectorAll('[class*="iP2t7d"], [class*="fontTitleSmall"]')) {
  const name = h.textContent.trim();
  if (!KNOWN_ATTR.test(name)) continue;   // skip map controls, day names, etc.
  // collect items from the section
}
```

### Feature labels

```js
const FEATURE_RE = /wheelchair|accessible|restroom|parking|delivery|dine.?in|
                    takeout|outdoor|indoor|wi-?fi|seating|catering|kid|child|
                    pet|live.?music|private|event|background|dress.?code|
                    no.?contact|curbside|air.?condition|heating/i;

[...document.querySelectorAll('[aria-label]')]
  .map(el => el.getAttribute('aria-label'))
  .filter(s => FEATURE_RE.test(s))
```

This is a broad scan — it finds feature strings regardless of where they appear in the DOM. Duplicate values are removed with `new Set(...)`.

### Review keywords (topic chips)

```js
// Topic chips are buttons whose text ends with a number count
// e.g. "wedding venue 14", "pool 7", "garden 4"
[...document.querySelectorAll('button, [role="button"]')]
  .map(el => el.textContent.trim())
  .filter(t => t && /\s\d+$/.test(t) && t.length < 60 && !/^(All|\+\d+)/.test(t))
```

The `+\d+` exclusion filters out the "Show N more" overflow chip.

### Reviews

**Key fix:** The original selector `[data-review-id], [class*="jJc9Ad"]` matched 3–4 overlapping elements per review (outer wrapper + inner containers). The fix: use only `[data-review-id]`, which Google assigns once per unique review.

```js
[...document.querySelectorAll('[data-review-id]')].map(el => ({
  author:        el.querySelector('[class*="d4r55"], .X43Kjb')?.textContent,
  isLocalGuide:  /local guide/i.test(badgeEl.textContent),
  reviewerStats: badgeEl.textContent,    // "Local Guide · 208 reviews · 1,148 photos"
  rating:        parseFloat(ratingAriaLabel.match(/([\d.]+)\s+star/i)?.[1]),
  date:          el.querySelector('[class*="rsqaWe"]')?.textContent,
  text:          el.querySelector('[class*="wiI7pd"]')?.textContent,
  likeCount:     el.querySelector('[aria-label*="Helpful"]')?.textContent,
}))
```

**Secondary deduplication:** Even with `data-review-id`, Google's DOM can have wrapper elements that share the same review-id. A `Set` keyed by `author|date|text` eliminates any remaining duplicates.

**Filter:** Entries with `null` author or no text and no rating are discarded.

### coLocated ("At this place")

```js
const atPlaceEl = [...document.querySelectorAll('[role="heading"], h2, h3')]
  .find(el => /^at this place$/i.test(el.textContent.trim()));
// then find a[href*="/maps/place/"] within the section container
```

### peopleAlsoSearch

```js
const alsoEl = [...document.querySelectorAll('[role="heading"], h2, h3')]
  .find(el => /people also search/i.test(el.textContent));
// then find a[href*="/maps/place/"] within the section container
```

### rawInfoBlocks (catch-all)

```js
[...document.querySelectorAll('[class*="rogA2c"] > div, [class*="m6QErb"] > div')]
  .map(el => el.textContent.trim())
  .filter(t => t.length > 2 && t.length < 300)
```

`rogA2c` and `m6QErb` are the obfuscated class names Google uses on info panel containers. They change between Google Maps releases — check `rawInfoBlocks` if structured fields stop populating.

---

## Coordinate Extraction

Coordinates are parsed from the venue URL, not the DOM:

```
URL pattern: ...!3d8.4718096!4d124.7004011...
Regex:       /!3d(-?[\d.]+)!4d(-?[\d.]+)/
```

This is more reliable than DOM scraping (the coordinate values in the URL are canonical) and adds zero page load time.

---

## Known Limitations

### Google Maps class names change

Google Maps uses minified/obfuscated CSS class names (`fontHeadlineSmall`, `W4Efsd`, `d4r55`, etc.) that can change in any Google Maps release. If the scraper suddenly returns empty results or missing fields, inspect the current DOM in DevTools and update the selectors in `detailExtractor.js`.

**How to debug:** Open any Google Maps venue page in Chrome, open DevTools console, paste the `EXTRACTOR` function body, and run it directly. You'll see exactly what each selector returns.

### Only visible reviews are captured

Google Maps shows ~3–10 reviews in the sidebar by default. The "More reviews" button leads to a full review page not currently scraped. `reviewCount` tells you how many exist total; `reviews` only contains what's visible in the sidebar.

### Open/closed status is a snapshot

`location.hours` (e.g. `"Open · Closes 5 PM"`) reflects the status at the time of scraping. The HTML map will show stale open/closed status if venues have changed hours or you're viewing the map on a different day.

### Rate limiting

Google Maps may return incomplete pages or show CAPTCHA challenges if scraping is too aggressive. Symptoms: many retry warnings, venues with `details: { error: "..." }`. Mitigation: reduce `--concurrency` to 1 or 2, add longer delays.

### Google Maps result cap

The search feed appears to cap at approximately 120 venues per search URL regardless of how many scrolls you perform. To capture more venues in an area, use multiple searches with different:
- Search terms (`"Event venue"`, `"Function room"`, `"Convention center"`)
- Zoom levels (wider zoom = different result set)
- Map center coordinates

Then merge the output JSON files, deduplicating by venue URL.

### Popular times not captured

The "Popular times" bar chart requires the page to load a specific section and is not currently extracted. The raw data is visible in `rawInfoBlocks` as a string of hour labels, but parsing it into a structured object would require additional logic.
