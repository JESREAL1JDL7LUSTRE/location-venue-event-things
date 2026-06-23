import { Hono } from 'hono';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsEvent, eventsOrganizer } from '../../drizzle/schema.js';

export const organizersRouter = new Hono();

const PAGE_SIZE = 50;

organizersRouter.get('/', async (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  const status = c.req.query('status')?.trim() ?? '';
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions = [];
  if (q) {
    conditions.push(
      or(ilike(eventsOrganizer.name, `%${q}%`), ilike(eventsOrganizer.city, `%${q}%`), ilike(eventsOrganizer.email, `%${q}%`)),
    );
  }
  if (status) conditions.push(eq(eventsOrganizer.status, status));

  const [{ total }] = await db
    .select({ total: count() })
    .from(eventsOrganizer)
    .where(and(...conditions));

  const rows = await db
    .select()
    .from(eventsOrganizer)
    .where(and(...conditions))
    .orderBy(eventsOrganizer.name)
    .limit(PAGE_SIZE)
    .offset(offset);

  const results = rows.map((o) => ({
    slug: o.slug,
    name: o.name,
    status: o.status,
    email: o.email,
    phone: o.phone,
    website: o.website,
    city: o.city,
    country: o.country,
    facebook_url: o.facebookUrl,
    instagram_url: o.instagramUrl,
    description: o.description,
    source: o.source,
    scraped_at: o.scrapedAt,
  }));

  return c.json({ results, total, pages: Math.ceil(total / PAGE_SIZE), page });
});

organizersRouter.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const rows = await db
    .select()
    .from(eventsOrganizer)
    .where(eq(eventsOrganizer.slug, slug))
    .limit(1);

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  const o = rows[0];

  const events = await db
    .select({ slug: eventsEvent.slug, name: eventsEvent.name, startsAt: eventsEvent.startsAt, category: eventsEvent.category, venueId: eventsEvent.venueId })
    .from(eventsEvent)
    .where(eq(eventsEvent.organizerRefId, o.id))
    .orderBy(desc(eventsEvent.startsAt))
    .limit(50);

  return c.json({
    slug: o.slug,
    name: o.name,
    status: o.status,
    email: o.email,
    phone: o.phone,
    website: o.website,
    address: o.address,
    city: o.city,
    country: o.country,
    facebook_url: o.facebookUrl,
    instagram_url: o.instagramUrl,
    description: o.description,
    source: o.source,
    source_url: o.sourceUrl,
    scraped_at: o.scrapedAt,
    events: events.map((e) => ({ slug: e.slug, name: e.name, starts_at: e.startsAt, category: e.category })),
  });
});
