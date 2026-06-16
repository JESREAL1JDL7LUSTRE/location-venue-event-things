# Interactive Map

`output/map.html` is a **self-contained** interactive map — no server, no API key, no installation required. Open it directly in any modern browser.

---

## Opening the Map

```bash
# After scraping:
npm run map           # builds output/map.html from venues.json

# Open in browser:
start output/map.html          # Windows
open output/map.html           # macOS
xdg-open output/map.html       # Linux
```

The map requires an internet connection to load:
- Google Fonts (Fira Code + Fira Sans typography)
- Leaflet.js (map library)
- CartoDB Dark Matter tiles (the dark map background)

---

## UI Layout

```
┌────────────────────────────────────────────────────────────┐
│  [logo] VenueMap CDO    Cagayan de Oro · Event Venues   54 venues  12 open now  │
├────────────────┬───────────────────────────────────────────┤
│                │                                           │
│  [🔍 Search ]  │                                           │
│                │                                           │
│  [All] [Event] │           Dark Map                        │
│  [Function]    │         (CartoDB tiles)                   │
│  [Community]   │                                           │
│                │         ● green pins                      │
│  54 venues     │           (clickable)                     │
│  □ Open now    │                                           │
│ ─────────────  │                                           │
│  Venue cards   │                                           │
│  (scrollable)  │                                           │
│                │                                           │
└────────────────┴───────────────────────────────────────────┘
```

On mobile (< 700px): map stacks on top, sidebar below.

---

## Features

### Top Bar

- **Brand** — project name and subtitle
- **Total venues** — count of venues loaded in the dataset
- **Open now** — count of venues currently showing "Open" status, with a pulsing green indicator

### Search

Real-time search (200ms debounce) across:
- Venue name
- Category
- Full address
- List-page address

Type to filter both the sidebar list and map pins simultaneously.

**No results state:** when no venues match, the list shows an icon and "Try a different search term or clear the filters."

### Category Filter Chips

The 6 most common categories in the dataset are shown as clickable chips. Click a chip to filter; click **All** to reset. Only one category is active at a time.

### Open Now Toggle

Checkbox toggle to show only venues with `location.hours` starting with "Open". Status is pulled from the data at scrape time — it reflects the open/closed status when the scraper ran.

### Venue Cards (Sidebar)

Each card shows:
- **Name** (bold)
- **Star rating** (SVG stars + numeric value in Fira Code)
- **Category**
- **Address** (truncated with ellipsis)
- **Open/Closed badge** (green/red)
- **Review count**

Clicking a card:
1. Highlights the card with a green left border
2. Pans the map to the venue and zooms to level 15 if needed
3. Opens the venue's popup on the map

### Map Pins

- **Active (selected) venue** — bright green pin `#22C55E`
- **Other visible venues** — slate blue-grey pin `#475569`
- **Clicking a pin** — selects the venue (same as clicking the sidebar card)

### Venue Popup

Clicking a pin or card opens a dark popup with:

**Header**
- Venue name
- Star rating with count in parentheses
- Category badge
- Open/Closed badge
- "Unclaimed" badge (yellow) if `isClaimed === false`

**Info rows** (icon + value)
- Full address
- Located in (parent venue)
- Plus code
- Phone number
- Website (linked, opens in new tab)
- Coordinates (lat/lng in Fira Code, 5 decimal places)

**Weekly hours table** (if available)
- Day → hours in Fira Code monospace

**Topics** (if available)
- Review keyword chips with mention counts

**Features** (if available)
- Feature label tags (accessibility, service options, etc.)

**Description** (if available)
- Truncated to 200 characters

**Top reviews** (up to 2)
- Author name + "Local Guide" badge if applicable
- Star rating (★ characters)
- Review text (truncated to 140 characters)

**People also search** (if available)
- Suggested similar venue names as tags

**Action buttons**
- **Google Maps** (green) — opens the venue's Google Maps page in a new tab
- **Website** (secondary) — opens the venue's website in a new tab (only shown if `website` is present)

---

## Rebuilding the Map

The map embeds all venue data inline as a JSON literal. After re-scraping, always rebuild:

```bash
npm run map
```

This reads `src/map-template.html` (the source template with `VENUES_DATA_PLACEHOLDER`) and writes `output/map.html` with the actual JSON injected. The template is never modified.

**Important:** Do not edit `output/map.html` directly. Changes are overwritten every time `npm run map` runs. Edit `src/map-template.html` instead.

---

## Customizing the Map

### Change the default search URL shown in the title

Edit `src/map-template.html`, find `.brand-sub` and update the text:

```html
<div class="brand-sub">Cagayan de Oro · Event Venues</div>
```

### Change map center / zoom

The map auto-centers to the average lat/lng of all venues. To override, find this line in the template:

```js
const map = L.map('map', { zoomControl: false }).setView([avgLat, avgLng], 13);
```

Replace `avgLat, avgLng` with fixed coordinates and adjust `13` (zoom level).

### Use a different map tile style

Replace the tile URL in the template. Options:

```js
// Dark (current)
'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'

// Light
'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'

// OpenStreetMap standard
'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
```

### Add more category filter chips

The chips are generated automatically from the top-6 most common categories in the data. To show more:

```js
const topCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 6)...
//                                                                           ^ change this
```

---

## Map Limitations

- **Static data** — the map shows data from the last scrape. Open/closed status may be stale.
- **~120 venue limit** — Google Maps caps results per search. Use multiple searches with different terms or zoom levels for broader coverage.
- **No clustering** — if many venues are at the same coordinates (e.g., a mall with multiple event spaces), pins overlap. Leaflet.markercluster can be added to handle this.
- **Offline use** — Leaflet, fonts, and tile images are loaded from CDNs. The map won't render correctly without internet access.
