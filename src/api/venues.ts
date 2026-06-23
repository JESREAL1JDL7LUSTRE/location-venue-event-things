import { Hono } from 'hono';
import { and, asc, count, desc, eq, ilike, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsEvent, eventsVenue } from '../../drizzle/schema.js';

export const venuesRouter = new Hono();

const PAGE_SIZE = 50;

venuesRouter.get('/map', async (c) => {
  const pins = await db
    .select({
      slug: eventsVenue.slug,
      name: eventsVenue.name,
      address: eventsVenue.address,
      city: eventsVenue.city,
      country: eventsVenue.country,
      primaryTypeDisplay: eventsVenue.primaryTypeDisplay,
      agentsPrimaryTypes: eventsVenue.agentsPrimaryTypes,
      rating: eventsVenue.rating,
      latitude: eventsVenue.latitude,
      longitude: eventsVenue.longitude,
      verificationStatus: eventsVenue.verificationStatus,
      website: eventsVenue.website,
    })
    .from(eventsVenue)
    .where(and(isNotNull(eventsVenue.latitude), isNotNull(eventsVenue.longitude)));

  return c.json(pins.map((p) => ({
    slug: p.slug,
    name: p.name,
    address: p.address,
    city: p.city,
    country: p.country,
    primary_type_display: p.primaryTypeDisplay,
    agents_primary_types: p.agentsPrimaryTypes,
    rating: p.rating,
    latitude: p.latitude,
    longitude: p.longitude,
    verification_status: p.verificationStatus,
    website: p.website,
  })));
});

venuesRouter.get('/types', async (c) => {
  const rows = await db
    .selectDistinct({ type: eventsVenue.primaryTypeDisplay })
    .from(eventsVenue)
    .where(sql`${eventsVenue.primaryTypeDisplay} != ''`)
    .orderBy(asc(eventsVenue.primaryTypeDisplay));
  return c.json(rows.map((r) => r.type));
});

venuesRouter.get('/', async (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  const status = c.req.query('status')?.trim() ?? '';
  const venueType = c.req.query('type')?.trim() ?? '';
  const ordering = c.req.query('ordering')?.trim() ?? '';
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions = [];
  if (q) conditions.push(or(ilike(eventsVenue.name, `%${q}%`), ilike(eventsVenue.city, `%${q}%`)));
  if (status) conditions.push(eq(eventsVenue.verificationStatus, status));
  if (venueType) conditions.push(eq(eventsVenue.primaryTypeDisplay, venueType));

  const orderMap: Record<string, ReturnType<typeof asc>> = {
    name: asc(eventsVenue.name),
    '-name': desc(eventsVenue.name),
    city: asc(eventsVenue.city),
    '-city': desc(eventsVenue.city),
    rating: asc(eventsVenue.rating),
    '-rating': desc(eventsVenue.rating),
  };
  const order = orderMap[ordering] ?? asc(eventsVenue.name);

  const [{ total }] = await db
    .select({ total: count() })
    .from(eventsVenue)
    .where(and(...conditions));

  const rows = await db
    .select({
      slug: eventsVenue.slug,
      name: eventsVenue.name,
      city: eventsVenue.city,
      country: eventsVenue.country,
      primaryTypeDisplay: eventsVenue.primaryTypeDisplay,
      agentsPrimaryTypes: eventsVenue.agentsPrimaryTypes,
      rating: eventsVenue.rating,
      verificationStatus: eventsVenue.verificationStatus,
      source: eventsVenue.source,
    })
    .from(eventsVenue)
    .where(and(...conditions))
    .orderBy(order)
    .limit(PAGE_SIZE)
    .offset(offset);

  const results = rows.map((v) => ({
    slug: v.slug,
    name: v.name,
    city: v.city,
    country: v.country,
    primary_type_display: v.primaryTypeDisplay,
    agents_primary_types: v.agentsPrimaryTypes,
    rating: v.rating,
    verification_status: v.verificationStatus,
    source: v.source,
  }));

  return c.json({ results, total, pages: Math.ceil(total / PAGE_SIZE), page });
});

venuesRouter.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const rows = await db
    .select()
    .from(eventsVenue)
    .where(eq(eventsVenue.slug, slug))
    .limit(1);

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  const v = rows[0];

  const events = await db
    .select({ slug: eventsEvent.slug, name: eventsEvent.name, startsAt: eventsEvent.startsAt, category: eventsEvent.category, organizer: eventsEvent.organizer })
    .from(eventsEvent)
    .where(eq(eventsEvent.venueId, v.id))
    .orderBy(desc(eventsEvent.startsAt))
    .limit(50);

  return c.json({
    slug: v.slug,
    name: v.name,
    address: v.address,
    city: v.city,
    country: v.country,
    website: v.website,
    rating: v.rating,
    about: v.about,
    primary_type_display: v.primaryTypeDisplay,
    agents_primary_types: v.agentsPrimaryTypes,
    verification_status: v.verificationStatus,
    source: v.source,
    source_url: v.sourceUrl,
    scraped_at: v.scrapedAt,
    events: events.map((e) => ({ slug: e.slug, name: e.name, starts_at: e.startsAt, category: e.category, organizer: e.organizer })),
  });
});

venuesRouter.patch('/:slug/status', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json();
  const status = body?.status;
  if (!['pending', 'verified', 'rejected'].includes(status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }
  const rows = await db
    .select({ id: eventsVenue.id })
    .from(eventsVenue)
    .where(eq(eventsVenue.slug, slug))
    .limit(1);
  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  await db
    .update(eventsVenue)
    .set({ verificationStatus: status, updatedAt: new Date().toISOString() })
    .where(eq(eventsVenue.id, rows[0].id));
  return c.json({ slug, verification_status: status });
});
