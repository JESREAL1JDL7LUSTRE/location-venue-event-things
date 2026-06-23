export interface ScrapedVenue {
  name: string;
  address?: string;
  city?: string;
  country?: string;
  website?: string;
  latitude?: number | null;
  longitude?: number | null;
  sourceUrl?: string;
  placeId?: string;
  primaryType?: string;
  primaryTypeDisplay?: string;
  types?: unknown[];
  about?: string;
  amenities?: Record<string, unknown>;
  rating?: number | null;
  priceLevel?: string;
}

export interface ScrapedOrganizer {
  name: string;
  website?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  facebookUrl?: string;
  instagramUrl?: string;
  description?: string;
  externalId?: string;
  sourceUrl?: string;
  imageUrl?: string;
}

export interface ScrapedEvent {
  name: string;
  description?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  url?: string;
  imageUrl?: string;
  price?: string;
  category?: string;
  externalId?: string;
  sourceUrl?: string;
  organizer?: string;
  organizerUrl?: string;
  venue?: ScrapedVenue | null;
}

export type ScrapedItem = ScrapedEvent | ScrapedVenue | ScrapedOrganizer;

export abstract class BaseScraper {
  abstract readonly source: string;

  abstract run(options?: Record<string, unknown>): Promise<RunResult>;
}

export interface RunResult {
  source: string;
  created: number;
  updated: number;
  eventIds?: number[];
  [key: string]: unknown;
}
