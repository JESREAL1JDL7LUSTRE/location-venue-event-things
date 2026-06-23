import { Hono } from 'hono';
import { and, asc, count, desc, eq, gte, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsEvent, eventsOrganizer, eventsVenue } from '../../drizzle/schema.js';

export const eventsRouter = new Hono();

const PAGE_SIZE = 50;

eventsRouter.get('/', async (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  const source = c.req.query('source')?.trim() ?? '';
  const category = c.req.query('category')?.trim() ?? '';
  const upcoming = c.req.query('upcoming') === '1';
  const ordering = c.req.query('ordering')?.trim() ?? '';
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions = [];
  if (q) conditions.push(or(ilike(eventsEvent.name, `%${q}%`), ilike(eventsEvent.description, `%${q}%`)));
  if (source) conditions.push(eq(eventsEvent.source, source));
  if (category) conditions.push(eq(eventsEvent.category, category));
  if (upcoming) conditions.push(gte(eventsEvent.startsAt, new Date().toISOString()));

  const orderMap: Record<string, ReturnType<typeof asc>> = {
    name: asc(eventsEvent.name),
    '-name': desc(eventsEvent.name),
    starts_at: asc(eventsEvent.startsAt),
    '-starts_at': desc(eventsEvent.startsAt),
  };
  const order = orderMap[ordering] ?? desc(eventsEvent.scrapedAt);

  const [{ total }] = await db
    .select({ total: count() })
    .from(eventsEvent)
    .where(and(...conditions));

  const rows = await db
    .select({
      slug: eventsEvent.slug,
      name: eventsEvent.name,
      startsAt: eventsEvent.startsAt,
      endsAt: eventsEvent.endsAt,
      category: eventsEvent.category,
      agentCategories: eventsEvent.agentCategories,
      source: eventsEvent.source,
      price: eventsEvent.price,
      url: eventsEvent.url,
      venueId: eventsEvent.venueId,
      organizerRefId: eventsEvent.organizerRefId,
      organizer: eventsEvent.organizer,
      venueName: eventsVenue.name,
      venueSlug: eventsVenue.slug,
      organizerName: eventsOrganizer.name,
      organizerSlug: eventsOrganizer.slug,
    })
    .from(eventsEvent)
    .leftJoin(eventsVenue, eq(eventsEvent.venueId, eventsVenue.id))
    .leftJoin(eventsOrganizer, eq(eventsEvent.organizerRefId, eventsOrganizer.id))
    .where(and(...conditions))
    .orderBy(order)
    .limit(PAGE_SIZE)
    .offset(offset);

  const results = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    starts_at: r.startsAt,
    ends_at: r.endsAt,
    category: r.category,
    agent_categories: r.agentCategories,
    source: r.source,
    price: r.price,
    venue: r.venueName ?? null,
    venue_slug: r.venueSlug ?? null,
    organizer: r.organizerName ?? r.organizer,
    organizer_slug: r.organizerSlug ?? null,
    url: r.url,
  }));

  return c.json({ results, total, pages: Math.ceil(total / PAGE_SIZE), page });
});

eventsRouter.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const rows = await db
    .select()
    .from(eventsEvent)
    .leftJoin(eventsVenue, eq(eventsEvent.venueId, eventsVenue.id))
    .leftJoin(eventsOrganizer, eq(eventsEvent.organizerRefId, eventsOrganizer.id))
    .where(eq(eventsEvent.slug, slug))
    .limit(1);

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  const { events_event: e, events_venue: v, events_organizer: o } = rows[0];

  return c.json({
    slug: e.slug,
    name: e.name,
    description: e.description,
    starts_at: e.startsAt,
    ends_at: e.endsAt,
    url: e.url,
    image_url: e.imageUrl,
    price: e.price,
    category: e.category,
    agent_categories: e.agentCategories,
    organizer: o?.name ?? e.organizer,
    organizer_url: e.organizerUrl,
    organizer_slug: o?.slug ?? null,
    source: e.source,
    source_url: e.sourceUrl,
    scraped_at: e.scrapedAt,
    venue: v ? { name: v.name, slug: v.slug, address: v.address, city: v.city, country: v.country } : null,
  });
});
