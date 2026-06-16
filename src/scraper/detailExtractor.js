/* Browser-side extraction function — serialized and injected via page.evaluate() */
export const EXTRACTOR = () => {
  const clean      = (s) => s?.replace(/\s+/g, ' ').trim() ?? null;
  const cleanHrs   = (s) => (s ?? '').replace(/,?\s*Copy open hours/gi, '').trim();
  const toInt      = (s) => parseInt((s ?? '').replace(/,/g, ''), 10) || null;
  const PLUS_RE    = /^[A-Z0-9]{4,}\+[A-Z0-9]{2,}/;
  const KNOWN_ATTR = /^(Accessibility|Service options|Offerings|Planning|Amenities|Highlights|Crowd|Dining options|Children|Payments|Parking|Pets|From the business)/i;
  const FEATURE_RE = /wheelchair|accessible|restroom|parking|delivery|dine.?in|takeout|outdoor|indoor|wi-?fi|seating|catering|kid|child|pet|live.?music|private|event|background|dress.?code|no.?contact|curbside|air.?condition|heating/i;
  const DAYS_RE    = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;

  const main   = document.querySelector('[role="main"]');
  const result = {};

  /* ── Core info (phone, address, website, plus code) ──────────────────────── */
  for (const el of document.querySelectorAll('[data-item-id]')) {
    const id    = el.getAttribute('data-item-id') ?? '';
    const label = clean(el.getAttribute('aria-label') ?? el.textContent);
    if (!label) continue;
    if (id.startsWith('phone'))  result.phone       = label.replace(/^Phone:\s*/i, '');
    else if (id === 'address')   result.fullAddress  = label.replace(/^Address:\s*/i, '');
    else if (id === 'authority') result.website      = el.href ?? null;
    else if (PLUS_RE.test(label) || /plus.?code/i.test(label))
      result.plusCode = label.replace(/^Plus\s*code:\s*/i, '');
  }
  if (!result.plusCode) {
    for (const btn of document.querySelectorAll('button[aria-label]')) {
      const lbl = clean(btn.getAttribute('aria-label'));
      if (PLUS_RE.test(lbl ?? '')) { result.plusCode = lbl; break; }
    }
  }

  /* ── Located in ──────────────────────────────────────────────────────────── */
  for (const el of document.querySelectorAll('[class*="fontBodyMedium"], [class*="Io6YTe"]')) {
    const t = clean(el.textContent);
    if (t?.toLowerCase().startsWith('located in')) {
      result.locatedIn = t.replace(/^located in:\s*/i, '');
      break;
    }
  }

  /* ── Weekly hours ────────────────────────────────────────────────────────── */
  const hoursTable = {};
  for (const row of document.querySelectorAll('table.WgFkxc tr, [class*="y0skZc"] tr')) {
    const cells = [...row.querySelectorAll('td')].map((td) => clean(td.textContent));
    if (cells.length >= 2) hoursTable[cells[0]] = cleanHrs(cells.slice(1).join(' '));
  }
  if (!Object.keys(hoursTable).length) {
    for (const el of document.querySelectorAll('[aria-label]')) {
      const lbl = clean(el.getAttribute('aria-label') ?? '');
      if (!DAYS_RE.test(lbl)) continue;
      const [day, ...rest] = lbl.split(',');
      hoursTable[clean(day)] = cleanHrs(rest.join(','));
    }
  }
  if (Object.keys(hoursTable).length) result.weeklyHours = hoursTable;

  /* ── Description ─────────────────────────────────────────────────────────── */
  const descEl = document.querySelector('[class*="PYvSYb"]') ?? document.querySelector('div[jslog*="description"]');
  if (descEl) result.description = clean(descEl.textContent);

  /* ── Price ───────────────────────────────────────────────────────────────── */
  const priceEl = document.querySelector('[aria-label*="Price"]');
  if (priceEl) result.price = clean(priceEl.getAttribute('aria-label')).replace(/^Price:\s*/i, '');

  /* ── Review count ────────────────────────────────────────────────────────── */
  for (const el of document.querySelectorAll('[aria-label]')) {
    const m = (el.getAttribute('aria-label') ?? '').match(/([\d,]+)\s+review/i);
    if (m) { result.reviewCount = toInt(m[1]); break; }
  }

  /* ── Rating distribution (5★ → count) ───────────────────────────────────── */
  const ratingDist = {};
  for (const el of document.querySelectorAll('[aria-label]')) {
    const m = (el.getAttribute('aria-label') ?? '').match(/^(\d)\s+star[^,]*,\s*([\d,]+)/i);
    if (m) ratingDist[+m[1]] = toInt(m[2]);
  }
  if (Object.keys(ratingDist).length) result.ratingDistribution = ratingDist;

  /* ── isClaimed ───────────────────────────────────────────────────────────── */
  result.isClaimed = ![...document.querySelectorAll('a, button')]
    .some((el) => /claim this business/i.test(el.textContent));

  /* ── Attribute sections (scoped to main panel, known headings only) ──────── */
  const sections = {};
  for (const h of (main?.querySelectorAll('[class*="iP2t7d"], [class*="fontTitleSmall"]') ?? [])) {
    const name = clean(h.textContent);
    if (!name || !KNOWN_ATTR.test(name)) continue;
    const container = h.closest('li, div, section');
    const items = [...(container?.querySelectorAll('li, [class*="hpLkke"]') ?? [])]
      .map((li) => clean(li.textContent)).filter(Boolean);
    if (items.length) sections[name] = items;
  }
  if (Object.keys(sections).length) result.attributes = sections;

  /* ── Feature labels (expanded regex) ────────────────────────────────────── */
  const features = [...new Set(
    [...document.querySelectorAll('[aria-label]')]
      .map((el) => clean(el.getAttribute('aria-label')))
      .filter((s) => s && FEATURE_RE.test(s)),
  )];
  if (features.length) result.featureLabels = features;

  /* ── Review keywords (topic chips with mention counts) ───────────────────── */
  const keywords = [...new Set(
    [...document.querySelectorAll('button, [role="button"]')]
      .map((el) => clean(el.textContent))
      .filter((t) => t && /\s\d+$/.test(t) && t.length < 60 && !/^(All|\+\d+)/.test(t)),
  )];
  if (keywords.length) result.reviewKeywords = keywords;

  /* ── coLocated places ("At this place") ─────────────────────────────────── */
  const atPlaceEl = [...document.querySelectorAll('[role="heading"], h2, h3')]
    .find((el) => /^at this place$/i.test(el.textContent.trim()));
  if (atPlaceEl) {
    const container = atPlaceEl.closest('[role="region"]') ?? atPlaceEl.parentElement?.parentElement;
    const coLocated = [...(container?.querySelectorAll('a[href*="/maps/place/"]') ?? [])]
      .map((a) => {
        const lbl = clean(a.getAttribute('aria-label') ?? a.textContent);
        return lbl ? { name: lbl } : null;
      }).filter(Boolean);
    if (coLocated.length) result.coLocated = coLocated;
  }

  /* ── People also search for ──────────────────────────────────────────────── */
  const alsoEl = [...document.querySelectorAll('[role="heading"], h2, h3')]
    .find((el) => /people also search/i.test(el.textContent));
  if (alsoEl) {
    const container = alsoEl.closest('[role="region"]') ?? alsoEl.parentElement?.parentElement;
    const also = [...(container?.querySelectorAll('a[href*="/maps/place/"]') ?? [])]
      .map((a) => clean(a.getAttribute('aria-label') ?? a.textContent))
      .filter((s) => s && s.length < 80);
    if (also.length) result.peopleAlsoSearch = also;
  }

  /* ── Reviews (FIXED: unique by data-review-id + dedup, reviewer metadata) ── */
  const seen    = new Set();
  const reviews = [...document.querySelectorAll('[data-review-id]')].map((el) => {
    const badgeEl   = el.querySelector('[class*="RfnDt"], [class*="Lqthgc"]');
    const badgeTxt  = clean(badgeEl?.textContent ?? '');
    return {
      author        : clean(el.querySelector('[class*="d4r55"], .X43Kjb')?.textContent),
      isLocalGuide  : /local guide/i.test(badgeTxt),
      reviewerStats : badgeTxt || null,
      rating        : parseFloat((el.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') ?? '').match(/([\d.]+)\s+star/i)?.[1]) || null,
      date          : clean(el.querySelector('[class*="rsqaWe"]')?.textContent),
      text          : clean(el.querySelector('[class*="wiI7pd"]')?.textContent),
      likeCount     : toInt(el.querySelector('[aria-label*="Helpful"]')?.textContent?.replace(/\D/g, '') ?? ''),
    };
  }).filter((r) => {
    if (!r.author || (!r.text && !r.rating)) return false;
    const key = `${r.author}|${r.date}|${r.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (reviews.length) result.reviews = reviews;

  /* ── Raw info blocks (catch-all) ─────────────────────────────────────────── */
  const rawInfoBlocks = [...new Set(
    [...document.querySelectorAll('[class*="rogA2c"] > div, [class*="m6QErb"] > div')]
      .map((el) => clean(el.textContent))
      .filter((t) => t && t.length > 2 && t.length < 300),
  )];
  if (rawInfoBlocks.length) result.rawInfoBlocks = rawInfoBlocks;

  return result;
};
