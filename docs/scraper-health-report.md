# Scraper Health Report — 2026-06-24

Test run of all scrapers (except `facebook_events`) with `SCRAPER_LIMIT=5` to cap DB writes at 5 items per scraper. Each scraper ran fully — the limit only applies at save time, so collection logs reflect real upstream data.

---

## Summary

| Status | Scrapers |
|--------|----------|
| Working | clickthecity, luma, myruntime, planout, racemeister_events, ticket2me, eventbrite, google_places, racemeister_partners |
| Returning 0 (API/parse issues) | eventbee, eventbookings, ticketmelon, sistic |
| Cloudflare blocked | allevents_in, allevents_in_organizers, happeningnext_cdo, eventalways, meetup, ticketspice, eventsize |
| Broken (runtime error) | google_maps |
| Skipped | facebook_events |

---

## Working Scrapers

| Scraper | Collected | Notes |
|---------|-----------|-------|
| `clickthecity` | 221 events | Clean. |
| `luma` | 27 events, 26 organizers | Clean. |
| `myruntime` | 853 events, 73 organizers | Large dataset, working well. |
| `planout` | 4 events, 4 organizers | Low volume — upstream may have few PH events. |
| `racemeister_events` | 17 events, 13 organizers | Clean. |
| `ticket2me` | 34 events, 26 organizers | Several 404s on `/get_shows` detail calls (some event IDs are expired/removed on their AWS API), but base event list and save succeeded. |
| `eventbrite` | 98 events, 53 organizers | Clean. |
| `google_places` | 188 venues | Clean. |
| `racemeister_partners` | 20 organizers | 3 partner websites returned 404 (outdoorstatement.com, goodneighbors.ph) — dead links on Racemeister's own page, not a scraper bug. |

---

## Returning 0 — Needs Investigation

### `eventbee`
- **Symptom:** API returned 0 events.
- **Likely cause:** Eventbee may have removed PH events or changed their API response format.
- **Action:** Check the API response manually and verify the endpoint and filter params still return PH data.

### `eventbookings`
- **Symptom:** 0 listings from POST API.
- **Likely cause:** API endpoint or payload may have changed; possible geo-filter issue.
- **Action:** Replay the POST request manually and inspect the response body.

### `ticketmelon`
- **Symptom:** Found 480 URLs from sitemap but parsed 0 events.
- **Likely cause:** The NEXT_DATA JSON extraction or HTML structure on event detail pages has changed.
- **Action:** Fetch one event URL manually and check if `__NEXT_DATA__` is still present and the expected keys still exist.

### `sistic`
- **Symptom:** `404 Not Found` on `https://cms.sistic.com.sg/api/events?limit=30&first=0`.
- **Likely cause:** SISTIC migrated or versioned their CMS API. The endpoint is dead.
- **Action:** Check the SISTIC website network traffic (DevTools) to find the current API endpoint and update `src/scrapers/sistic.ts`.

---

## Cloudflare Blocked

All Playwright-based scrapers that hit Cloudflare-protected sites returned 0 results. These are not broken — they worked before — but Cloudflare's bot detection is now catching the current stealth configuration.

| Scraper | Blocked URLs |
|---------|-------------|
| `allevents_in` | manila, davao, cagayan-de-oro listing pages |
| `allevents_in_organizers` | All 123 event detail pages |
| `happeningnext_cdo` | Listing page |
| `eventalways` | All 8 category pages |
| `meetup` | GraphQL intercept returned 0 (likely blocked pre-intercept) |
| `ticketspice` | Google SERP scraping returned 0 URLs |
| `eventsize` | Google SERP scraping returned 0 URLs |

**Common remedies:**
1. **Proxy rotation** — route Playwright requests through a residential proxy (DataImpulse is already configured for Facebook; extend to other scrapers).
2. **playwright-stealth update** — ensure the latest `playwright-stealth` fingerprint patches are applied.
3. **Slowdown / human-like delays** — add random delays between page navigations.
4. **Browser profile reuse** — use a persistent browser context with cookies/localStorage to appear as a returning user.

---

## Broken Scraper

### `google_maps`
- **Error:** `getListPageVenues is not a function`
- **Root cause:** The Puppeteer-based `google_maps` scraper calls a function (`getListPageVenues`) that no longer exists or was not exported correctly. This is likely a leftover reference from the old `src/scraper/listPage.js` (the legacy JS scraper) that was never updated when the TS rewrite happened.
- **File:** `src/scrapers/google-maps.ts`
- **Action:** Open `google-maps.ts`, locate the `getListPageVenues` call, and either fix the import or rewrite the list-page extraction to match the current Puppeteer page structure.

---

## Environment

```
SCRAPER_LIMIT=5        # capped DB writes per scraper
facebook_events        # skipped (requires proxy + FB credentials)
Run date: 2026-06-24
```

---

## Priority Fixes

1. **`google_maps`** — Runtime crash; fix broken function import in `google-maps.ts`.
2. **`sistic`** — Dead API endpoint; find new SISTIC API URL.
3. **`ticketmelon`** — 480 URLs collected but 0 parsed; NEXT_DATA structure probably changed.
4. **Cloudflare scrapers** — Evaluate proxy strategy for `allevents_in`, `happeningnext_cdo`, `eventalways`, `meetup`.
5. **`eventbee` / `eventbookings`** — Verify API endpoints still return PH data.
