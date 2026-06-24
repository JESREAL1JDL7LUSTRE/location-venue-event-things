import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsSearchquery } from '../../drizzle/schema.js';

export const searchQueriesRouter = new Hono();

const serialize = (sq: typeof eventsSearchquery.$inferSelect) => ({
  id: sq.id,
  query: sq.query,
  source: sq.source,
  is_active: sq.isActive,
  last_run_at: sq.lastRunAt,
  events_found_count: sq.eventsFoundCount,
  created_at: sq.createdAt,
  updated_at: sq.updatedAt,
});

searchQueriesRouter.get('/', async (c) => {
  const source = c.req.query('source')?.trim() ?? '';
  const conditions = source ? [eq(eventsSearchquery.source, source)] : [];
  const rows = await db
    .select()
    .from(eventsSearchquery)
    .where(and(...conditions))
    .orderBy(eventsSearchquery.source, eventsSearchquery.query);
  return c.json(rows.map(serialize));
});

searchQueriesRouter.post('/', async (c) => {
  const data = await c.req.json();
  const query = (data?.query ?? '').trim();
  const source = (data?.source ?? '').trim();
  if (!query) return c.json({ error: 'query is required' }, 400);

  const existing = await db
    .select({ id: eventsSearchquery.id })
    .from(eventsSearchquery)
    .where(eq(eventsSearchquery.query, query))
    .limit(1);
  if (existing.length) return c.json({ error: 'Query already exists' }, 409);

  const now = new Date().toISOString();
  const inserted = await db
    .insert(eventsSearchquery)
    .values({
      query,
      source,
      isActive: data?.is_active !== false,
      eventsFoundCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return c.json(serialize(inserted[0]), 201);
});

searchQueriesRouter.patch('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const data = await c.req.json();
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if ('query' in data) updates.query = (data.query ?? '').trim();
  if ('is_active' in data) updates.isActive = Boolean(data.is_active);
  if ('source' in data) updates.source = (data.source ?? '').trim();

  const rows = await db
    .update(eventsSearchquery)
    .set(updates)
    .where(eq(eventsSearchquery.id, id))
    .returning();
  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json(serialize(rows[0]));
});

searchQueriesRouter.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const deleted = await db
    .delete(eventsSearchquery)
    .where(eq(eventsSearchquery.id, id))
    .returning({ id: eventsSearchquery.id });
  if (!deleted.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ deleted: true });
});
