import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { statsRouter } from './api/stats.js';
import { eventsRouter } from './api/events.js';
import { venuesRouter } from './api/venues.js';
import { organizersRouter } from './api/organizers.js';
import { scrapersRouter } from './api/scrapers.js';
import { searchQueriesRouter } from './api/search-queries.js';
import { webhooksRouter } from './api/webhooks.js';

const app = new Hono();

app.use('*', logger());
app.use(
  '/api/*',
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Scraper-Key'],
  }),
);

app.route('/api/stats', statsRouter);
app.route('/api/events', eventsRouter);
app.route('/api/venues', venuesRouter);
app.route('/api/organizers', organizersRouter);
app.route('/api/scrapers', scrapersRouter);
app.route('/api/search-queries', searchQueriesRouter);
app.route('/api', webhooksRouter);

app.get('/', (c) => c.json({ name: 'node-scraper API', version: '1.0.0' }));

const PORT = parseInt(process.env.PORT ?? '8000', 10);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`);
});

export default app;
