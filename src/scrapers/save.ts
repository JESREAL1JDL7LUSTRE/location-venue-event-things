import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import slugify from 'slugify';
import { db } from '../db/client.js';
import { eventsEvent, eventsOrganizer, eventsVenue } from '../../drizzle/schema.js';
import type { ScrapedEvent, ScrapedOrganizer, ScrapedVenue } from './base.js';

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

const uniqueSlug = async (
  table: typeof eventsEvent | typeof eventsVenue | typeof eventsOrganizer,
  base: string,
): Promise<string> => {
  const slug = slugify(base, { lower: true, strict: true }) || 'item';
  let candidate = slug;
  let i = 2;
  while (true) {
    const existing = await db
      .select({ id: table.id })
      .from(table as typeof eventsEvent)
      .where(eq((table as typeof eventsEvent).slug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
    candidate = `${slug}-${i++}`;
  }
};

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

const truncateUrl = (url: string | null | undefined, maxLen: number): string => {
  const s = (url ?? '').trim();
  return s.length > maxLen ? s.substring(0, maxLen) : s;
};

// When SCRAPER_LIMIT is set (e.g. during testing), only save up to N items.
const testLimit = (): number | null => {
  const v = process.env.SCRAPER_LIMIT;
  if (!v) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
};

const normalizeUrl = (url: string | null | undefined): string => {
  if (!url) return '';
  try {
    const parsed = new URL(url.trim());
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.protocol = parsed.protocol.toLowerCase();
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return url.trim().replace(/\/+$/, '').toLowerCase();
  }
};

const dedupNormalizeUrl = (url: string | null | undefined): string => {
  if (!url) return '';
  try {
    const parsed = new URL(url.trim().toLowerCase());
    const params = [...parsed.searchParams.entries()]
      .filter(([k]) => !k.startsWith('utm_'))
      .sort(([a], [b]) => a.localeCompare(b));
    const path = parsed.pathname.replace(/\/+$/, '');
    const query = new URLSearchParams(params).toString();
    return `${parsed.host}${path}${query ? '?' + query : ''}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '');
  }
};

const normalizeName = (name: string | null | undefined): string => {
  if (!name) return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const isBlank = (v: unknown): boolean => {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
};

// ---------------------------------------------------------------------------
// Venue upsert
// ---------------------------------------------------------------------------

export const upsertVenue = async (
  source: string,
  sv: ScrapedVenue,
  now: string,
): Promise<{ id: number; created: boolean }> => {
  let existing: { id: number } | undefined;

  if (sv.placeId) {
    const rows = await db
      .select({ id: eventsVenue.id })
      .from(eventsVenue)
      .where(and(eq(eventsVenue.source, source), eq(eventsVenue.placeId, sv.placeId)))
      .limit(1);
    existing = rows[0];
  }

  if (!existing) {
    const byName = await db
      .select({ id: eventsVenue.id })
      .from(eventsVenue)
      .where(and(eq(eventsVenue.source, source), eq(eventsVenue.name, sv.name)))
      .limit(1);
    existing = byName[0];
  }

  if (!existing) {
    const anyName = await db
      .select({ id: eventsVenue.id })
      .from(eventsVenue)
      .where(eq(eventsVenue.name, sv.name))
      .limit(1);
    existing = anyName[0];
  }

  const fields = {
    address: sv.address ?? '',
    city: sv.city ?? '',
    country: sv.country ?? '',
    website: sv.website ?? '',
    latitude: sv.latitude ?? null,
    longitude: sv.longitude ?? null,
    source,
    sourceUrl: sv.sourceUrl ?? '',
    placeId: sv.placeId ?? '',
    primaryType: sv.primaryType ?? '',
    primaryTypeDisplay: sv.primaryTypeDisplay ?? '',
    types: (sv.types ?? []) as unknown[],
    about: sv.about ?? '',
    amenities: (sv.amenities ?? {}) as Record<string, unknown>,
    rating: sv.rating ?? null,
    priceLevel: sv.priceLevel ?? '',
    scrapedAt: now,
    updatedAt: now,
  };

  if (existing) {
    await db.update(eventsVenue).set(fields).where(eq(eventsVenue.id, existing.id));
    return { id: existing.id, created: false };
  }

  const slug = await uniqueSlug(eventsVenue, sv.name);
  const inserted = await db
    .insert(eventsVenue)
    .values({
      name: sv.name,
      slug,
      verificationStatus: 'pending',
      agentsPrimaryTypes: [],
      createdAt: now,
      ...fields,
    })
    .returning({ id: eventsVenue.id });
  return { id: inserted[0].id, created: true };
};

// ---------------------------------------------------------------------------
// Organizer resolution
// ---------------------------------------------------------------------------

const resolveOrganizer = async (
  organizerUrl: string | undefined,
  organizerName: string | undefined,
): Promise<number | null> => {
  const urlKey = normalizeUrl(organizerUrl);
  if (urlKey) {
    const all = await db
      .select({ id: eventsOrganizer.id, website: eventsOrganizer.website })
      .from(eventsOrganizer)
      .where(gt(eventsOrganizer.website, ''));
    const match = all.find((o) => normalizeUrl(o.website) === urlKey);
    if (match) return match.id;
  }

  const name = (organizerName ?? '').trim();
  if (name) {
    const matches = await db
      .select({ id: eventsOrganizer.id })
      .from(eventsOrganizer)
      .where(sql`lower(${eventsOrganizer.name}) = ${name.toLowerCase()}`)
      .limit(2);
    if (matches.length === 1) return matches[0].id;
  }

  return null;
};

// ---------------------------------------------------------------------------
// save_events
// ---------------------------------------------------------------------------

export const saveEvents = async (
  source: string,
  events: ScrapedEvent[],
): Promise<{ source: string; created: number; updated: number; eventIds: number[] }> => {
  const limit = testLimit();
  const items = limit !== null ? events.slice(0, limit) : events;
  if (limit !== null) console.log(`[test] saveEvents: capped at ${limit} (of ${events.length})`);

  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  const eventIds: number[] = [];

  for (const se of items) {
    let venueId: number | null = null;
    if (se.venue) {
      const v = await upsertVenue(source, se.venue, now);
      venueId = v.id;
    }

    let existing: { id: number } | undefined;
    if (se.externalId) {
      const rows = await db
        .select({ id: eventsEvent.id })
        .from(eventsEvent)
        .where(and(eq(eventsEvent.source, source), eq(eventsEvent.externalId, se.externalId)))
        .limit(1);
      existing = rows[0];
    }

    const organizerRefId = await resolveOrganizer(se.organizerUrl, se.organizer);

    const fields = {
      name: se.name,
      description: se.description ?? '',
      venueId,
      startsAt: se.startsAt?.toISOString() ?? null,
      endsAt: se.endsAt?.toISOString() ?? null,
      url: se.url ?? '',
      imageUrl: se.imageUrl ?? '',
      price: se.price ?? '',
      category: se.category ?? '',
      organizer: (se.organizer ?? '').substring(0, 255),
      organizerUrl: se.organizerUrl ?? '',
      organizerRefId,
      source,
      sourceUrl: se.sourceUrl ?? '',
      externalId: se.externalId ?? '',
      scrapedAt: now,
      updatedAt: now,
    };

    if (existing) {
      await db.update(eventsEvent).set(fields).where(eq(eventsEvent.id, existing.id));
      updated++;
      eventIds.push(existing.id);
    } else {
      const slug = await uniqueSlug(eventsEvent, se.name);
      const inserted = await db
        .insert(eventsEvent)
        .values({
          slug,
          agentCategories: [],
          registrationUrl: '',
          createdAt: now,
          ...fields,
        })
        .returning({ id: eventsEvent.id });
      created++;
      eventIds.push(inserted[0].id);
    }
  }

  await dedupEventsByUrl(eventIds).catch((err) =>
    console.warn('dedup events failed:', err),
  );

  return { source, created, updated, eventIds };
};

// ---------------------------------------------------------------------------
// save_organizers
// ---------------------------------------------------------------------------

export const saveOrganizers = async (
  source: string,
  organizers: ScrapedOrganizer[],
): Promise<{ source: string; created: number; updated: number }> => {
  const limit = testLimit();
  const items = limit !== null ? organizers.slice(0, limit) : organizers;

  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  const orgIds: number[] = [];

  for (const so of items) {
    let existing: { id: number } | undefined;

    if (so.externalId) {
      const rows = await db
        .select({ id: eventsOrganizer.id })
        .from(eventsOrganizer)
        .where(and(eq(eventsOrganizer.source, source), eq(eventsOrganizer.externalId, so.externalId)))
        .limit(1);
      existing = rows[0];
    }

    if (!existing) {
      const rows = await db
        .select({ id: eventsOrganizer.id })
        .from(eventsOrganizer)
        .where(and(eq(eventsOrganizer.source, source), eq(eventsOrganizer.name, so.name)))
        .limit(1);
      existing = rows[0];
    }

    const contactFields = {
      name: so.name,
      website: truncateUrl(so.website, 200),
      email: so.email ?? '',
      phone: so.phone ?? '',
      address: so.address ?? '',
      city: so.city ?? '',
      country: so.country ?? '',
      facebookUrl: truncateUrl(so.facebookUrl, 200),
      instagramUrl: truncateUrl(so.instagramUrl, 200),
      description: so.description ?? '',
      source,
      sourceUrl: truncateUrl(so.sourceUrl, 200),
      externalId: so.externalId ?? '',
      scrapedAt: now,
      updatedAt: now,
    };

    if (existing) {
      const current = await db
        .select()
        .from(eventsOrganizer)
        .where(eq(eventsOrganizer.id, existing.id))
        .limit(1);
      const org = current[0];
      const updates: Record<string, unknown> = {
        name: so.name,
        source,
        scrapedAt: now,
        updatedAt: now,
      };
      const fillableKeys = ['website', 'email', 'phone', 'address', 'city', 'country', 'facebookUrl', 'instagramUrl', 'description', 'sourceUrl', 'externalId'] as const;
      for (const k of fillableKeys) {
        const newVal = contactFields[k];
        const dbKey = k === 'facebookUrl' ? 'facebookUrl' : k === 'instagramUrl' ? 'instagramUrl' : k;
        if (!isBlank(newVal) && isBlank((org as Record<string, unknown>)[dbKey])) {
          updates[dbKey] = newVal;
        }
      }
      await db.update(eventsOrganizer).set(updates).where(eq(eventsOrganizer.id, existing.id));
      updated++;
      orgIds.push(existing.id);
    } else {
      const slug = await uniqueSlug(eventsOrganizer, so.name);
      const inserted = await db
        .insert(eventsOrganizer)
        .values({ slug, status: 'pending', enrichedAt: null, enrichmentSource: '', createdAt: now, ...contactFields })
        .returning({ id: eventsOrganizer.id });
      created++;
      orgIds.push(inserted[0].id);
    }
  }

  await dedupOrganizersByWebsite(orgIds).catch((err) =>
    console.warn('dedup organizers failed:', err),
  );

  return { source, created, updated };
};

// ---------------------------------------------------------------------------
// save_venues (venue-only scraper, e.g. Google Places)
// ---------------------------------------------------------------------------

export const saveVenues = async (
  source: string,
  venues: ScrapedVenue[],
): Promise<{ source: string; created: number; updated: number }> => {
  const limit = testLimit();
  const items = limit !== null ? venues.slice(0, limit) : venues;

  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  const venueIds: number[] = [];

  for (const sv of items) {
    const result = await upsertVenue(source, sv, now);
    venueIds.push(result.id);
    if (result.created) created++;
    else updated++;
  }

  await dedupVenuesByNameCity(venueIds).catch((err) =>
    console.warn('dedup venues failed:', err),
  );

  return { source, created, updated };
};

// ---------------------------------------------------------------------------
// Dedup helpers (inline, best-effort)
// ---------------------------------------------------------------------------

const groupBy = <T>(
  rows: T[],
  keyFn: (row: T) => string,
): number[][] => {
  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    const k = keyFn(row);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push((row as { id: number }).id);
  }
  return [...buckets.values()].filter((g) => g.length >= 2).map((g) => g.sort((a, b) => a - b));
};

const mergeGroups = (groups: number[][]): number[][] => {
  const merged: Set<number>[] = [];
  for (const group of groups) {
    const g = new Set(group);
    let placed = false;
    for (const existing of merged) {
      if ([...g].some((id) => existing.has(id))) {
        for (const id of g) existing.add(id);
        placed = true;
        break;
      }
    }
    if (!placed) merged.push(new Set(g));
  }
  return merged.map((s) => [...s].sort((a, b) => a - b)).filter((g) => g.length >= 2);
};

const dedupEventsByUrl = async (ids: number[]) => {
  if (!ids.length) return;
  const rows = await db
    .select({ id: eventsEvent.id, url: eventsEvent.url })
    .from(eventsEvent)
    .where(and(inArray(eventsEvent.id, ids), gt(eventsEvent.url, '')));

  const groups = groupBy(rows, (r) => dedupNormalizeUrl(r.url));
  for (const group of groups) {
    const [winnerId, ...loserIds] = group;
    const winner = await db.select().from(eventsEvent).where(eq(eventsEvent.id, winnerId)).limit(1);
    const losers = await db.select().from(eventsEvent).where(inArray(eventsEvent.id, loserIds));
    const updates: Record<string, unknown> = {};
    const skipKeys = new Set(['id', 'slug', 'createdAt', 'updatedAt', 'agentCategories', 'source', 'externalId']);
    for (const [k, wv] of Object.entries(winner[0])) {
      if (skipKeys.has(k)) continue;
      if (!isBlank(wv)) continue;
      for (const loser of losers) {
        const lv = (loser as Record<string, unknown>)[k];
        if (!isBlank(lv)) { updates[k] = lv; break; }
      }
    }
    if (Object.keys(updates).length) {
      await db.update(eventsEvent).set(updates).where(eq(eventsEvent.id, winnerId));
    }
    await db.delete(eventsEvent).where(inArray(eventsEvent.id, loserIds));
  }
};

const dedupVenuesByNameCity = async (ids: number[]) => {
  if (!ids.length) return;
  const rows = await db
    .select({ id: eventsVenue.id, website: eventsVenue.website, name: eventsVenue.name, city: eventsVenue.city, placeId: eventsVenue.placeId })
    .from(eventsVenue)
    .where(inArray(eventsVenue.id, ids));

  const webGroups = groupBy(
    rows.filter((r) => r.website),
    (r) => dedupNormalizeUrl(r.website),
  );
  const nameGroups = groupBy(rows, (r) => `${normalizeName(r.name)}::${(r.city ?? '').toLowerCase().trim()}`);

  const placeIdMap = new Map(rows.map((r) => [r.id, r.placeId]));
  const filteredNameGroups = nameGroups.filter((g) => {
    const ids = new Set(g.map((id) => placeIdMap.get(id)).filter(Boolean));
    return ids.size < 2;
  });

  const allGroups = mergeGroups([...webGroups, ...filteredNameGroups]);
  for (const group of allGroups) {
    const [winnerId, ...loserIds] = group;
    await db.update(eventsEvent).set({ venueId: winnerId }).where(inArray(eventsEvent.venueId, loserIds));
    await db.delete(eventsVenue).where(inArray(eventsVenue.id, loserIds));
  }
};

const dedupOrganizersByWebsite = async (ids: number[]) => {
  if (!ids.length) return;
  const rows = await db
    .select({ id: eventsOrganizer.id, website: eventsOrganizer.website, name: eventsOrganizer.name })
    .from(eventsOrganizer)
    .where(inArray(eventsOrganizer.id, ids));

  const webGroups = groupBy(
    rows.filter((r) => r.website),
    (r) => dedupNormalizeUrl(r.website),
  );
  const nameGroups = groupBy(rows, (r) => normalizeName(r.name));
  const allGroups = mergeGroups([...webGroups, ...nameGroups]);

  for (const group of allGroups) {
    const [winnerId, ...loserIds] = group;
    await db.update(eventsEvent).set({ organizerRefId: winnerId }).where(inArray(eventsEvent.organizerRefId, loserIds));
    await db.delete(eventsOrganizer).where(inArray(eventsOrganizer.id, loserIds));
  }
};
