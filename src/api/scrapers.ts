import { Hono } from 'hono';
import { and, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsEvent, eventsOrganizer, eventsScraperrun } from '../../drizzle/schema.js';
import { SCRAPERS } from '../scrapers/registry.js';
import { cancelRun, createScraperRun, markRunFailed, markRunStarted, markRunSuccess } from '../scrapers/runner.js';

export const scrapersRouter = new Hono();

const serializeRun = (run: typeof eventsScraperrun.$inferSelect) => {
  const now = new Date();
  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
  const isActive = ['queued', 'running'].includes(run.status);
  const recentlyFinished = finishedAt && (now.getTime() - finishedAt.getTime()) < 300_000;
  const includeLog = isActive || recentlyFinished;

  return {
    id: run.id,
    scraper_key: run.scraperKey,
    status: run.status,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    created_count: run.createdCount,
    updated_count: run.updatedCount,
    extra_counts: run.extraCounts,
    error_message: run.errorMessage || null,
    created_at: run.createdAt,
    duration_seconds: run.startedAt && run.finishedAt
      ? (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
      : null,
    log_output: includeLog ? run.logOutput : null,
  };
};

scrapersRouter.get('/', async (c) => {
  const eventLastRows = await db
    .select({ source: eventsEvent.source, last: max(eventsEvent.scrapedAt) })
    .from(eventsEvent)
    .where(sql`${eventsEvent.source} != ''`)
    .groupBy(eventsEvent.source);

  const orgLastRows = await db
    .select({ source: eventsOrganizer.source, last: max(eventsOrganizer.scrapedAt) })
    .from(eventsOrganizer)
    .where(sql`${eventsOrganizer.source} != ''`)
    .groupBy(eventsOrganizer.source);

  const eventLast = new Map(eventLastRows.map((r) => [r.source, r.last]));
  const orgLast = new Map(orgLastRows.map((r) => [r.source, r.last]));

  const allKeys = Object.keys(SCRAPERS);
  const latestRunRows = await db
    .selectDistinctOn([eventsScraperrun.scraperKey], {
      scraperKey: eventsScraperrun.scraperKey,
      status: eventsScraperrun.status,
      startedAt: eventsScraperrun.startedAt,
      finishedAt: eventsScraperrun.finishedAt,
    })
    .from(eventsScraperrun)
    .where(inArray(eventsScraperrun.scraperKey, allKeys))
    .orderBy(eventsScraperrun.scraperKey, desc(eventsScraperrun.createdAt));

  const latestRuns = new Map(latestRunRows.map((r) => [r.scraperKey, r]));

  const results = allKeys.map((key) => {
    const eTs = eventLast.get(key);
    const oTs = orgLast.get(key);
    let lastScraped: string | null = null;
    if (eTs && oTs) lastScraped = eTs > oTs ? eTs : oTs;
    else lastScraped = eTs ?? oTs ?? null;

    const run = latestRuns.get(key);
    return {
      key,
      last_scraped: lastScraped,
      last_run: run
        ? { status: run.status, started_at: run.startedAt, finished_at: run.finishedAt }
        : null,
    };
  });

  return c.json(results);
});

scrapersRouter.post('/:key/run', async (c) => {
  const key = c.req.param('key');
  if (!(key in SCRAPERS)) return c.json({ error: 'Unknown scraper key' }, 404);

  const { id, alreadyActive } = await createScraperRun(key);
  if (alreadyActive) return c.json({ error: 'Scraper already running' }, 409);

  const pid = process.pid;
  markRunStarted(id, pid).catch(() => {});

  (async () => {
    try {
      const scraper = new SCRAPERS[key]();
      const result = await scraper.run();
      const { created, updated, ...rest } = result;
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (k !== 'source' && k !== 'eventIds') extra[k] = v;
      }
      await markRunSuccess(id, created, updated, extra);
    } catch (err) {
      await markRunFailed(id, err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return c.json({ id, status: 'queued' });
});

scrapersRouter.post('/run-all', async (c) => {
  const keys = Object.keys(SCRAPERS);
  const created = [];
  const skipped = [];

  for (const key of keys) {
    const { id, alreadyActive } = await createScraperRun(key);
    if (alreadyActive) {
      skipped.push(key);
    } else {
      created.push({ key, id, status: 'queued' });
      const pid = process.pid;
      markRunStarted(id, pid).catch(() => {});
      (async () => {
        try {
          const scraper = new SCRAPERS[key]();
          const result = await scraper.run();
          const { created: c, updated: u, ...rest } = result;
          const extra: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rest)) {
            if (k !== 'source' && k !== 'eventIds') extra[k] = v;
          }
          await markRunSuccess(id, c, u, extra);
        } catch (err) {
          await markRunFailed(id, err instanceof Error ? err : new Error(String(err)));
        }
      })();
    }
  }

  return c.json({ created, skipped });
});

scrapersRouter.get('/runs', async (c) => {
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') ?? '50', 10) || 50));
  const runs = await db
    .select()
    .from(eventsScraperrun)
    .orderBy(desc(eventsScraperrun.createdAt))
    .limit(limit);
  return c.json(runs.map(serializeRun));
});

scrapersRouter.get('/runs/active', async (c) => {
  const runs = await db
    .select()
    .from(eventsScraperrun)
    .where(inArray(eventsScraperrun.status, ['queued', 'running']));
  return c.json(runs.map(serializeRun));
});

scrapersRouter.get('/runs/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const rows = await db.select().from(eventsScraperrun).where(eq(eventsScraperrun.id, id)).limit(1);
  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeRun(rows[0]));
});

scrapersRouter.post('/runs/:id/cancel', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const { found, wasActive } = await cancelRun(id);
  if (!found) return c.json({ error: 'Run not found' }, 404);
  if (!wasActive) return c.json({ error: 'Run is not active' }, 409);
  const rows = await db.select().from(eventsScraperrun).where(eq(eventsScraperrun.id, id)).limit(1);
  return c.json(serializeRun(rows[0]));
});
