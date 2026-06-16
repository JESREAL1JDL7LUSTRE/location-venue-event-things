# Data Schema

`output/venues.json` is an array of venue objects. Each object has a top-level stub (from the list page) merged with `coords` and `details` (from the detail page).

---

## Top-Level Venue Object

```jsonc
{
  // ── From list page (Phase 1) ───────────────────────────────────────────────
  "name":     "Cove Garden Resort",          // string   — venue display name
  "rating":   4.7,                           // number | null — aggregate star rating (1–5)
  "reviews":  null,                          // always null — legacy field, not used
  "location": { ... },                       // object — quick-access location fields
  "url":      "https://www.google.com/maps/place/...", // string — Google Maps detail URL

  // ── From detail page (Phase 2) ────────────────────────────────────────────
  "coords":  { "lat": 8.4718096, "lng": 124.7004011 }, // object | null
  "details": { ... }                         // object — all enriched data
}
```

### `location` (from list page)

Quick-access fields parsed directly from the search card. These are overridden/supplemented by the richer `details` fields from the detail page.

```jsonc
"location": {
  "category": "Event venue",               // string | null — business type
  "address":  "Cugman, CDO",               // string | null — often short/partial
  "plusCode": "FPC2+P5",                   // string | null — Google Plus Code
  "hours":    "Open · Closes 5 PM"         // string | null — current open/closed status
}
```

**Note:** `location.address` is frequently an empty string (`""`) on the list page. Use `details.fullAddress` for the complete address.

### `coords`

Coordinates parsed directly from the Google Maps URL — reliable, no DOM scraping required.

```jsonc
"coords": {
  "lat": 8.4718096,    // number — latitude (WGS84)
  "lng": 124.7004011   // number — longitude (WGS84)
}
```

`null` if the URL does not contain coordinate tokens (rare — usually means the venue has no fixed location).

---

## `details` Object

All fields inside `details` are optional — they are only present if the data was found on the venue's page. A missing field means the venue doesn't have that information publicly listed on Google Maps.

### Contact & Identity

| Field | Type | Description |
|-------|------|-------------|
| `fullAddress` | `string` | Complete street address including barangay, city, province, ZIP |
| `phone` | `string` | Primary phone number as displayed |
| `website` | `string` | Official website URL (full href, not display text) |
| `plusCode` | `string` | Google Plus Code (e.g. `"FPC2+P5 Cagayan De Oro City"`) |
| `locatedIn` | `string` | Parent venue name if this place is inside another (e.g. `"SM City CDO"`) |
| `price` | `string` | Price range or level as shown (e.g. `"₱₱"`, `"Inexpensive"`) |
| `description` | `string` | Owner-provided business description from the "About" section |
| `isClaimed` | `boolean` | `true` if the business owner has claimed the listing; `false` if "Claim this business" link is present |

### Hours

| Field | Type | Description |
|-------|------|-------------|
| `weeklyHours` | `object` | Day-of-week → hours string map |

```jsonc
"weeklyHours": {
  "Monday":    "8 AM–5 PM",
  "Tuesday":   "8 AM–5 PM",
  "Wednesday": "8 AM–5 PM",
  "Thursday":  "8 AM–5 PM",
  "Friday":    "8 AM–5 PM",
  "Saturday":  "8 AM–5 PM",
  "Sunday":    "8 AM–5 PM"
}
```

Values like `"Open 24 hours"` or `"Closed"` are preserved as-is. The `"Copy open hours"` artifact from Google Maps is stripped at extraction time.

### Ratings & Reviews

| Field | Type | Description |
|-------|------|-------------|
| `reviewCount` | `number` | Total review count as shown on the page |
| `ratingDistribution` | `object` | Star level (1–5) → count of reviews at that level |
| `reviewKeywords` | `string[]` | User-generated topic chips with mention counts |

```jsonc
"ratingDistribution": {
  "5": 210,
  "4": 60,
  "3": 12,
  "2": 4,
  "1": 5
}

"reviewKeywords": [
  "wedding venue 14",
  "garden wedding 4",
  "scenic beach view 2",
  "private ceremony 3"
]
```

`reviewKeywords` are the clickable topic pills shown above the review list. The trailing number is the mention count.

### `reviews` Array

Each element is one visible review from the page sidebar (typically 3–10 are visible without clicking "More reviews").

```jsonc
"reviews": [
  {
    "author":        "Kristohanong Bisdak Music",   // string | null
    "isLocalGuide":  false,                          // boolean — Local Guide badge
    "reviewerStats": "Local Guide · 208 reviews · 1,148 photos", // string | null
    "rating":        5,                              // number | null — 1–5 stars
    "date":          "5 months ago",                 // string | null — relative date
    "text":          "I had the opportunity...",     // string | null — review body
    "likeCount":     null                            // number | null — "Helpful" vote count
  }
]
```

**Deduplication:** Reviews are deduplicated by `author + date + text`. Only entries with at least `author` and one of `text` or `rating` are kept.

### Attributes & Features

| Field | Type | Description |
|-------|------|-------------|
| `attributes` | `object` | Named attribute sections → list of items |
| `featureLabels` | `string[]` | Accessibility/feature strings from `aria-label` attributes |

```jsonc
"attributes": {
  "Accessibility": [
    "Wheelchair accessible entrance",
    "Wheelchair accessible parking lot"
  ],
  "Service options": [
    "Dine-in",
    "Takeout",
    "Delivery"
  ],
  "Amenities": [
    "Wi-Fi",
    "Outdoor seating"
  ]
}

"featureLabels": [
  "Wheelchair accessible entrance",
  "Wheelchair accessible parking lot",
  "Outdoor seating"
]
```

`attributes` sections are only captured for known heading names: `Accessibility`, `Service options`, `Offerings`, `Planning`, `Amenities`, `Highlights`, `Crowd`, `Dining options`, `Children`, `Payments`, `Parking`, `Pets`, `From the business`.

`featureLabels` captures accessibility/feature strings found anywhere in `aria-label` attributes matching a broad keyword filter (wheelchair, parking, WiFi, catering, kids, pets, etc.).

### Discovery

| Field | Type | Description |
|-------|------|-------------|
| `coLocated` | `object[]` | Other businesses sharing the same physical address |
| `peopleAlsoSearch` | `string[]` | Similar venues shown in "People also search for" |

```jsonc
"coLocated": [
  { "name": "Fertilizer and Pesticide Authority Region X" }
]

"peopleAlsoSearch": [
  "Elarvee Event Venue",
  "D' Events Venue CDO",
  "Riverview Event Center"
]
```

### Catch-All

| Field | Type | Description |
|-------|------|-------------|
| `rawInfoBlocks` | `string[]` | Deduplicated text blocks from the info panel |

`rawInfoBlocks` is a best-effort catch-all that captures text content from the venue info sidebar. It often contains duplicate data already in structured fields, but also surface details not captured elsewhere (e.g. "Popular times" descriptions, photo counts, "Suggest an edit" prompts). Useful for debugging or discovering data not yet captured by dedicated extractors.

---

## Error Records

If a detail page fails after all retries, the venue is saved with:

```jsonc
{
  "name": "...",
  "rating": 4.2,
  "location": { ... },
  "url": "...",
  "coords": null,
  "details": {
    "error": "Navigation timeout of 60000 ms exceeded"
  }
}
```

These can be re-scraped on the next run (they are not cached, so they will be retried automatically).

---

## Field Presence by Venue Type

Not all venues have all fields. Common patterns:

| Field | Always present | Common | Rare |
|-------|---------------|--------|------|
| `name` | ✓ | | |
| `rating` | | ✓ | |
| `coords` | | ✓ | |
| `details.fullAddress` | | ✓ | |
| `details.phone` | | ✓ | |
| `details.website` | | | ✓ |
| `details.weeklyHours` | | ✓ | |
| `details.reviewCount` | | ✓ | |
| `details.reviews` | | ✓ | |
| `details.isClaimed` | ✓ | | |
| `details.description` | | | ✓ |
| `details.attributes` | | | ✓ |
| `details.featureLabels` | | ✓ | |
| `details.reviewKeywords` | | ✓ | |
| `details.ratingDistribution` | | | ✓ |
| `details.coLocated` | | | ✓ |
| `details.peopleAlsoSearch` | | ✓ | |
| `details.price` | | | ✓ |
| `details.locatedIn` | | | ✓ |
| `details.plusCode` | | ✓ | |
| `rawInfoBlocks` | | ✓ | |

---

## Complete Example Record

```jsonc
{
  "name": "Station 5 Events Place",
  "rating": 4.9,
  "reviews": null,
  "location": {
    "category": "Event venue",
    "address": "",
    "plusCode": "FM6V+XQC",
    "hours": "Open 24 hours"
  },
  "url": "https://www.google.com/maps/place/Station+5+Events+Place/...",
  "coords": {
    "lat": 8.4624319,
    "lng": 124.694379
  },
  "details": {
    "fullAddress": "FM6V+XQC, Cagayan De Oro City, Misamis Oriental",
    "phone": "0917 655 5530",
    "plusCode": "FM6V+XQC",
    "isClaimed": false,
    "weeklyHours": {
      "Monday":    "Open 24 hours",
      "Tuesday":   "Open 24 hours",
      "Wednesday": "Open 24 hours",
      "Thursday":  "Open 24 hours",
      "Friday":    "Open 24 hours",
      "Saturday":  "Open 24 hours",
      "Sunday":    "Open 24 hours"
    },
    "reviewCount": 15,
    "ratingDistribution": { "5": 14, "4": 1 },
    "reviewKeywords": [
      "city views 2",
      "special events 3",
      "weddings 3"
    ],
    "featureLabels": [
      "Wheelchair accessible entrance"
    ],
    "peopleAlsoSearch": [
      "D' Events Venue CDO",
      "Riverview Event Center",
      "My hub events place rental"
    ],
    "reviews": [
      {
        "author": "ukime hime",
        "isLocalGuide": true,
        "reviewerStats": "Local Guide · 208 reviews · 1,148 photos",
        "rating": 5,
        "date": "2 years ago",
        "text": "Great place for events 😍😍😍 My brother and his wife had their wedding reception here.",
        "likeCount": null
      }
    ],
    "rawInfoBlocks": [ "..." ]
  }
}
```
