import { Hono } from 'hono';
import { saveEvents } from '../scrapers/save.js';
import type { ScrapedEvent, ScrapedVenue } from '../scrapers/base.js';

export const webhooksRouter = new Hono();

const WEBHOOK_SECRET = process.env.SCRAPER_WEBHOOK_SECRET ?? '';

const authCheck = (c: { req: { header: (name: string) => string | undefined } }) => {
  const key = c.req.header('X-Scraper-Key') ?? '';
  return WEBHOOK_SECRET && key === WEBHOOK_SECRET;
};

webhooksRouter.post('/ingest-events', async (c) => {
  if (!authCheck(c)) return c.json({ error: 'unauthorized' }, 401);

  const data = await c.req.json();
  const source = (data?.source ?? '').trim();
  if (!source) return c.json({ error: 'source is required' }, 400);

  const eventsData = data?.events ?? [];
  if (!Array.isArray(eventsData)) return c.json({ error: 'events must be an array' }, 400);

  const scraped: ScrapedEvent[] = [];
  for (const ev of eventsData) {
    if (!ev || typeof ev !== 'object') continue;
    let startsAt: Date | null = null;
    let endsAt: Date | null = null;
    if (ev.starts_at) {
      try { startsAt = new Date(ev.starts_at); } catch { /* skip */ }
    }
    if (ev.ends_at) {
      try { endsAt = new Date(ev.ends_at); } catch { /* skip */ }
    }
    let venue: ScrapedVenue | null = null;
    if (ev.location?.trim()) venue = { name: ev.location.trim() };
    const url = (ev.url ?? '').trim();
    scraped.push({
      name: (ev.name ?? '').trim(),
      description: (ev.description ?? '').trim(),
      url,
      price: (ev.price ?? '').trim(),
      organizer: (ev.organizer ?? '').trim(),
      startsAt,
      endsAt,
      sourceUrl: url,
      externalId: (ev.external_id ?? url).trim(),
      venue,
    });
  }

  const result = await saveEvents(source, scraped);
  return c.json({ success: true, ...result });
});
