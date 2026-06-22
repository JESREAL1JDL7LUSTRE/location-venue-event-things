import type { BaseScraper } from './base.js';

import { ClickTheCityScraper } from './clickthecity.js';
import { LumaScraper } from './luma.js';
import { MyRuntimeScraper } from './myruntime.js';
import { PlanoutScraper } from './planout.js';
import { RacemeisterEventsScraper } from './racemeister-events.js';
import { Ticket2MeScraper } from './ticket2me.js';
import { EventbriteScraper } from './eventbrite.js';
import { EventbeeScraper } from './eventbee.js';
import { TicketmelonScraper } from './ticketmelon.js';
import { EventBookingsScraper } from './eventbookings.js';
import { SisticScraper } from './sistic.js';
import { RacemeisterPartnersScraper } from './racemeister-partners.js';
import { GooglePlacesVenueScraper } from './google-places.js';
import { AllEventsPHScraper } from './allevents-ph.js';
import { AllEventsPHOrganizersScraper } from './allevents-ph-organizers.js';
import { HappeningNextCDOScraper } from './happeningnext.js';
import { EventAlwaysScraper } from './eventalways.js';
import { MeetupScraper } from './meetup.js';
import { TicketSpiceScraper } from './ticketspice.js';
import { FacebookEventsScraper } from './facebook-events.js';
import { EventsizeScraper } from './eventsize.js';
import { GoogleMapsScraper } from './google-maps.js';

export interface ScraperMeta {
  key: string;
  label: string;
  description: string;
  usesPlaywright: boolean;
  requiresProxy?: boolean;
}

export const SCRAPERS: Record<string, { new (): BaseScraper; meta: ScraperMeta }> = {
  clickthecity: Object.assign(ClickTheCityScraper, {
    meta: { key: 'clickthecity', label: 'ClickTheCity', description: 'Events from ClickTheCity PH public JSON API', usesPlaywright: false },
  }),
  luma: Object.assign(LumaScraper, {
    meta: { key: 'luma', label: 'Luma', description: 'Events from Luma geo-discovery API (Manila, Cebu, Davao)', usesPlaywright: false },
  }),
  myruntime: Object.assign(MyRuntimeScraper, {
    meta: { key: 'myruntime', label: 'MyRuntime', description: 'Events from MyRuntime.com API', usesPlaywright: false },
  }),
  planout: Object.assign(PlanoutScraper, {
    meta: { key: 'planout', label: 'Planout', description: 'Events from Planout.io API', usesPlaywright: false },
  }),
  racemeister_events: Object.assign(RacemeisterEventsScraper, {
    meta: { key: 'racemeister_events', label: 'Racemeister Events', description: 'Racing events from Racemeister.com Google Apps Script APIs', usesPlaywright: false },
  }),
  ticket2me: Object.assign(Ticket2MeScraper, {
    meta: { key: 'ticket2me', label: 'Ticket2Me', description: 'Events from Ticket2Me.net AWS API', usesPlaywright: false },
  }),
  eventbrite: Object.assign(EventbriteScraper, {
    meta: { key: 'eventbrite', label: 'Eventbrite', description: 'PH events from Eventbrite listing pages + batch API', usesPlaywright: false },
  }),
  eventbee: Object.assign(EventbeeScraper, {
    meta: { key: 'eventbee', label: 'Eventbee', description: 'PH events from Eventbee.com', usesPlaywright: false },
  }),
  ticketmelon: Object.assign(TicketmelonScraper, {
    meta: { key: 'ticketmelon', label: 'Ticketmelon', description: 'PH events from Ticketmelon.com sitemap + NEXT_DATA', usesPlaywright: false },
  }),
  eventbookings: Object.assign(EventBookingsScraper, {
    meta: { key: 'eventbookings', label: 'EventBookings', description: 'PH events from EventBookings.com POST API + Schema.org JSON-LD', usesPlaywright: false },
  }),
  sistic: Object.assign(SisticScraper, {
    meta: { key: 'sistic', label: 'SISTIC', description: 'Singapore events from SISTIC Drupal REST API', usesPlaywright: false },
  }),
  racemeister_partners: Object.assign(RacemeisterPartnersScraper, {
    meta: { key: 'racemeister_partners', label: 'Racemeister Partners', description: 'Organizer gallery from Racemeister.com homepage', usesPlaywright: false },
  }),
  google_places: Object.assign(GooglePlacesVenueScraper, {
    meta: { key: 'google_places', label: 'Google Places', description: 'Venues in CDO via Google Places API (New)', usesPlaywright: false },
  }),
  allevents_in: Object.assign(AllEventsPHScraper, {
    meta: { key: 'allevents_in', label: 'AllEvents.in PH', description: 'PH events from AllEvents.in (Manila, Davao, CDO) — uses Playwright + Cloudflare bypass', usesPlaywright: true },
  }),
  allevents_in_organizers: Object.assign(AllEventsPHOrganizersScraper, {
    meta: { key: 'allevents_in_organizers', label: 'AllEvents.in Organizers', description: 'Two-phase organizer enrichment for AllEvents.in events', usesPlaywright: true },
  }),
  happeningnext_cdo: Object.assign(HappeningNextCDOScraper, {
    meta: { key: 'happeningnext_cdo', label: 'HappeningNext CDO', description: 'CDO events from HappeningNext.com — uses Playwright + Cloudflare bypass', usesPlaywright: true },
  }),
  eventalways: Object.assign(EventAlwaysScraper, {
    meta: { key: 'eventalways', label: 'EventAlways', description: 'PH events from EventAlways.com — uses Playwright + Cloudflare bypass', usesPlaywright: true },
  }),
  meetup: Object.assign(MeetupScraper, {
    meta: { key: 'meetup', label: 'Meetup', description: 'PH Meetup.com events via Playwright + GraphQL intercept', usesPlaywright: true },
  }),
  ticketspice: Object.assign(TicketSpiceScraper, {
    meta: { key: 'ticketspice', label: 'TicketSpice', description: 'TicketSpice events via Google SERP discovery + sitemap probing', usesPlaywright: true },
  }),
  facebook_events: Object.assign(FacebookEventsScraper, {
    meta: { key: 'facebook_events', label: 'Facebook Events', description: 'FB events via Playwright + optional proxy — requires active SearchQuery records', usesPlaywright: true, requiresProxy: true },
  }),
  eventsize: Object.assign(EventsizeScraper, {
    meta: { key: 'eventsize', label: 'EventSize', description: 'PH events from EventSize.com via API + Google SERP', usesPlaywright: true },
  }),
  google_maps: Object.assign(GoogleMapsScraper, {
    meta: { key: 'google_maps', label: 'Google Maps', description: 'Venues in CDO via Google Maps Puppeteer scraper (2-phase)', usesPlaywright: false },
  }),
};

export const getScraper = (key: string): BaseScraper | null => {
  const Cls = SCRAPERS[key];
  if (!Cls) return null;
  return new Cls();
};
