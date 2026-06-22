import { chromium } from 'playwright';
import { BaseScraper, type RunResult, type ScrapedEvent, type ScrapedOrganizer, type ScrapedVenue } from './base.js';
import { saveEvents, saveOrganizers } from './save.js';

const SEARCH_URL = 'https://www.meetup.com/find/?location=Cagayan+de+Oro%2C+Philippines&source=EVENTS&distance=tenMiles';
const SOURCE_URL = 'https://www.meetup.com/find/?location=Philippines';

const parseDt = (s: unknown): Date | null => {
  if (!s) return null;
  try { return new Date(String(s)); } catch { return null; }
};

const extractFromNextData = (nextData: Record<string, unknown>): Array<{ ev: ScrapedEvent; org: ScrapedOrganizer | null }> => {
  const results: Array<{ ev: ScrapedEvent; org: ScrapedOrganizer | null }> = [];
  try {
    const pageProps = ((nextData.props as Record<string, unknown>)?.pageProps as Record<string, unknown>) ?? {};
    const events = (pageProps.events as Record<string, unknown>[]) ?? [];
    for (const e of events) {
      const name = ((e.title as string) ?? '').trim();
      if (!name) continue;
      const group = (e.group as Record<string, unknown>) ?? {};
      const venue = (e.venue as Record<string, unknown>) ?? {};
      const venueName = ((venue.name as string) ?? '').trim();
      let sv: ScrapedVenue | null = null;
      if (venueName) {
        sv = {
          name: venueName,
          address: (venue.address as string) ?? '',
          city: (venue.city as string) ?? '',
          country: (venue.country as string) ?? 'Philippines',
          latitude: (venue.lat as number) || null,
          longitude: (venue.lon as number) || null,
          sourceUrl: SOURCE_URL,
        };
      }
      const org: ScrapedOrganizer | null = group.name
        ? {
            name: (group.name as string) ?? '',
            externalId: String(group.id ?? ''),
            sourceUrl: `https://www.meetup.com/${group.urlname ?? ''}`,
            description: (group.description as string) ?? '',
            imageUrl: (group.groupPhoto as Record<string, unknown>)?.photoUrl as string ?? '',
          }
        : null;
      results.push({
        ev: {
          name,
          description: ((e.description as string) ?? '').replace(/<[^>]+>/g, '').trim(),
          startsAt: parseDt(e.dateTime),
          endsAt: parseDt(e.endTime),
          url: (e.eventUrl as string) ?? '',
          imageUrl: (e.imageUrl as string) ?? '',
          price: (e.fee as Record<string, unknown>)?.amount ? `$${(e.fee as Record<string, unknown>).amount}` : 'Free',
          externalId: String(e.id ?? ''),
          sourceUrl: SOURCE_URL,
          organizer: (group.name as string) ?? '',
          organizerUrl: `https://www.meetup.com/${group.urlname ?? ''}`,
          venue: sv,
        },
        org,
      });
    }
  } catch (err) {
    console.error('meetup: NEXT_DATA parse error:', err);
  }
  return results;
};

const extractFromGraphQL = (responses: unknown[]): Array<{ ev: ScrapedEvent; org: ScrapedOrganizer | null }> => {
  const results: Array<{ ev: ScrapedEvent; org: ScrapedOrganizer | null }> = [];
  for (const resp of responses) {
    try {
      const data = resp as Record<string, unknown>;
      const edges = ((data.data as Record<string, unknown>)?.results as Record<string, unknown>)?.edges as Record<string, unknown>[] ?? [];
      for (const edge of edges) {
        const e = (edge.node as Record<string, unknown>) ?? {};
        const name = ((e.title as string) ?? '').trim();
        if (!name) continue;
        const group = (e.group as Record<string, unknown>) ?? {};
        const venue = (e.venue as Record<string, unknown>) ?? {};
        const venueName = ((venue.name as string) ?? '').trim();
        let sv: ScrapedVenue | null = null;
        if (venueName) {
          sv = { name: venueName, city: (venue.city as string) ?? '', country: 'Philippines', sourceUrl: SOURCE_URL };
        }
        const org: ScrapedOrganizer | null = group.name
          ? { name: (group.name as string), externalId: String(group.id ?? ''), sourceUrl: `https://www.meetup.com/${group.urlname ?? ''}` }
          : null;
        results.push({
          ev: {
            name,
            startsAt: parseDt(e.dateTime),
            endsAt: parseDt(e.endTime),
            url: (e.eventUrl as string) ?? '',
            imageUrl: '',
            price: 'Free',
            externalId: String(e.id ?? ''),
            sourceUrl: SOURCE_URL,
            organizer: (group.name as string) ?? '',
            organizerUrl: `https://www.meetup.com/${group.urlname ?? ''}`,
            venue: sv,
          },
          org,
        });
      }
    } catch { /* skip malformed */ }
  }
  return results;
};

export class MeetupScraper extends BaseScraper {
  readonly source = 'meetup';

  async run(): Promise<RunResult> {
    const graphqlResponses: unknown[] = [];
    const allResults: Array<{ ev: ScrapedEvent; org: ScrapedOrganizer | null }> = [];

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      // Intercept GraphQL responses
      page.on('response', async (response) => {
        if (response.url().includes('/gql2')) {
          try {
            const json = await response.json();
            graphqlResponses.push(json);
          } catch { /* skip */ }
        }
      });

      await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // Scroll to trigger lazy loading
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(1500);
      }

      // Extract NEXT_DATA
      const nextDataText = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? el.textContent : null;
      });

      if (nextDataText) {
        try {
          const nextData = JSON.parse(nextDataText) as Record<string, unknown>;
          allResults.push(...extractFromNextData(nextData));
        } catch (err) {
          console.error('meetup: failed to parse NEXT_DATA:', err);
        }
      }

      // Also extract from intercepted GraphQL
      allResults.push(...extractFromGraphQL(graphqlResponses));

      await context.close();
    } finally {
      await browser.close();
    }

    // Deduplicate by externalId
    const seenIds = new Set<string>();
    const events: ScrapedEvent[] = [];
    const orgMap = new Map<string, ScrapedOrganizer>();

    for (const { ev, org } of allResults) {
      if (ev.externalId && seenIds.has(ev.externalId)) continue;
      if (ev.externalId) seenIds.add(ev.externalId);
      events.push(ev);
      if (org && !orgMap.has(org.externalId ?? org.name)) {
        orgMap.set(org.externalId ?? org.name, org);
      }
    }

    console.log(`meetup: ${events.length} events, ${orgMap.size} organizers`);
    const evResult = await saveEvents(this.source, events);
    const orgResult = await saveOrganizers(this.source, [...orgMap.values()]);
    return { ...evResult, organizers_created: orgResult.created, organizers_updated: orgResult.updated };
  }
}
