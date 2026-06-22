import { Hono } from 'hono';
import { count, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsEvent, eventsVenue, eventsOrganizer } from '../../drizzle/schema.js';

export const statsRouter = new Hono();

statsRouter.get('/', async (c) => {
  const [events] = await db.select({ total: count() }).from(eventsEvent);
  const [venues] = await db.select({ total: count() }).from(eventsVenue);
  const [verifiedVenues] = await db
    .select({ total: count() })
    .from(eventsVenue)
    .where(sql`${eventsVenue.verificationStatus} = 'verified'`);
  const [organizers] = await db.select({ total: count() }).from(eventsOrganizer);
  const [confirmed] = await db
    .select({ total: count() })
    .from(eventsOrganizer)
    .where(sql`${eventsOrganizer.status} = 'confirmed'`);
  const [pending] = await db
    .select({ total: count() })
    .from(eventsOrganizer)
    .where(sql`${eventsOrganizer.status} = 'pending'`);
  const activeSources = await db
    .selectDistinct({ source: eventsEvent.source })
    .from(eventsEvent)
    .where(sql`${eventsEvent.source} != ''`);

  return c.json({
    total_events: events.total,
    total_venues: venues.total,
    verified_venues: verifiedVenues.total,
    total_organizers: organizers.total,
    confirmed_organizers: confirmed.total,
    pending_organizers: pending.total,
    active_sources: activeSources.length,
  });
});

statsRouter.get('/events-by-source', async (c) => {
  const data = await db
    .select({ source: eventsEvent.source, count: count() })
    .from(eventsEvent)
    .where(sql`${eventsEvent.source} != ''`)
    .groupBy(eventsEvent.source)
    .orderBy(sql`count(*) desc`);
  return c.json(data);
});

statsRouter.get('/events-by-category', async (c) => {
  const events = await db
    .select({ agentCategories: eventsEvent.agentCategories, category: eventsEvent.category })
    .from(eventsEvent);

  const buckets = new Map<string, number>();
  const withAgent = events.filter((e) => Array.isArray(e.agentCategories) && (e.agentCategories as unknown[]).length > 0);
  const withoutAgent = events.filter((e) => !Array.isArray(e.agentCategories) || (e.agentCategories as unknown[]).length === 0);

  for (const e of withAgent) {
    for (const label of (e.agentCategories as string[])) {
      if (label) buckets.set(label, (buckets.get(label) ?? 0) + 1);
    }
  }
  for (const e of withoutAgent) {
    const cat = (e.category ?? '').trim();
    if (cat) buckets.set(cat, (buckets.get(cat) ?? 0) + 1);
  }

  const sorted = [...buckets.entries()].sort(([, a], [, b]) => b - a);
  const TOP_N = 8;
  const top = sorted.slice(0, TOP_N).map(([category, count]) => ({ category, count }));
  const other = sorted.slice(TOP_N).reduce((s, [, c]) => s + c, 0);
  if (other > 0) top.push({ category: 'Other', count: other });

  return c.json(top);
});
