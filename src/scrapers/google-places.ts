import got from 'got';
import { BaseScraper, type RunResult, type ScrapedVenue } from './base.js';
import { saveVenues } from './save.js';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const CITY = 'Cagayan de Oro City, Philippines';
const MAX_PAGES = 3;

const SCALAR_AMENITIES: Record<string, string> = {
  allowsDogs: 'Pet-friendly', goodForChildren: 'Kid-friendly', goodForGroups: 'Good for groups',
  goodForWatchingSports: 'Good for watching sports', restroom: 'Restroom',
  servesBreakfast: 'Serves breakfast', servesLunch: 'Serves lunch', servesDinner: 'Serves dinner',
  servesBrunch: 'Serves brunch', servesBeer: 'Serves beer', servesWine: 'Serves wine',
  servesCocktails: 'Serves cocktails', servesCoffee: 'Serves coffee', servesDessert: 'Serves dessert',
  servesVegetarianFood: 'Vegetarian options', outdoorSeating: 'Outdoor seating', liveMusic: 'Live music',
  menuForChildren: "Kids' menu", reservable: 'Reservable', takeout: 'Takeout',
  delivery: 'Delivery', dineIn: 'Dine-in', curbsidePickup: 'Curbside pickup',
};

const NESTED_AMENITIES: Record<string, Record<string, string>> = {
  accessibilityOptions: {
    wheelchairAccessibleParking: 'Wheelchair-accessible parking',
    wheelchairAccessibleEntrance: 'Wheelchair-accessible entrance',
    wheelchairAccessibleRestroom: 'Wheelchair-accessible restroom',
    wheelchairAccessibleSeating: 'Wheelchair-accessible seating',
  },
  parkingOptions: {
    freeParkingLot: 'Free parking lot', paidParkingLot: 'Paid parking lot',
    freeStreetParking: 'Free street parking', paidStreetParking: 'Paid street parking',
    valetParking: 'Valet parking', freeGarageParking: 'Free garage parking',
    paidGarageParking: 'Paid garage parking',
  },
  paymentOptions: {
    acceptsCreditCards: 'Accepts credit cards', acceptsDebitCards: 'Accepts debit cards',
    acceptsCashOnly: 'Cash only', acceptsNfc: 'Accepts NFC payments',
  },
};

const VENUE_QUERIES = [
  `convention centers in ${CITY}`,
  `event venues in ${CITY}`,
  `theaters and performing arts venues in ${CITY}`,
  `auditoriums in ${CITY}`,
  `stadiums and sports arenas in ${CITY}`,
  `night clubs in ${CITY}`,
  `museums in ${CITY}`,
  `hotels with function halls in ${CITY}`,
];

const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.websiteUri', 'places.googleMapsUri', 'places.primaryType', 'places.primaryTypeDisplayName',
  'places.types', 'places.editorialSummary', 'places.rating', 'places.userRatingCount',
  'places.priceLevel', 'places.accessibilityOptions', 'places.parkingOptions', 'places.paymentOptions',
  ...Object.keys(SCALAR_AMENITIES).map((k) => `places.${k}`),
  'nextPageToken',
].join(',');

const normalizeAmenities = (place: Record<string, unknown>): Record<string, boolean> => {
  const amenities: Record<string, boolean> = {};
  for (const [key, label] of Object.entries(SCALAR_AMENITIES)) {
    if (place[key] === true) amenities[label] = true;
  }
  for (const [field, subMap] of Object.entries(NESTED_AMENITIES)) {
    const obj = (place[field] as Record<string, unknown>) ?? {};
    for (const [subKey, label] of Object.entries(subMap)) {
      if (obj[subKey] === true) amenities[label] = true;
    }
  }
  return amenities;
};

const toVenue = (place: Record<string, unknown>): ScrapedVenue => {
  const loc = (place.location as Record<string, unknown>) ?? {};
  const displayName = (place.displayName as Record<string, unknown>) ?? {};
  return {
    name: ((displayName.text as string) ?? '').trim(),
    address: (place.formattedAddress as string) ?? '',
    city: 'Cagayan de Oro',
    country: 'Philippines',
    website: (place.websiteUri as string) ?? '',
    latitude: (loc.latitude as number) ?? null,
    longitude: (loc.longitude as number) ?? null,
    sourceUrl: (place.googleMapsUri as string) ?? '',
    placeId: (place.id as string) ?? '',
    primaryType: (place.primaryType as string) ?? '',
    primaryTypeDisplay: ((place.primaryTypeDisplayName as Record<string, unknown>)?.text as string) ?? '',
    types: (place.types as string[]) ?? [],
    about: ((place.editorialSummary as Record<string, unknown>)?.text as string) ?? '',
    amenities: normalizeAmenities(place),
    rating: (place.rating as number) ?? null,
    priceLevel: (place.priceLevel as string) ?? '',
  };
};

export class GooglePlacesVenueScraper extends BaseScraper {
  readonly source = 'google_places';

  async run(): Promise<RunResult> {
    const apiKey = process.env.PLACES_API_KEY;
    if (!apiKey) throw new Error('PLACES_API_KEY is not set');

    const headers = {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    };

    const seen = new Set<string>();
    const venues: ScrapedVenue[] = [];

    for (const textQuery of VENUE_QUERIES) {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        try {
          const body: Record<string, unknown> = { textQuery, regionCode: 'PH' };
          if (pageToken) body.pageToken = pageToken;
          const resp = await got.post(SEARCH_URL, {
            headers,
            json: body,
            timeout: { request: 30_000 },
          }).json<{ places?: Record<string, unknown>[]; nextPageToken?: string }>();
          for (const place of resp.places ?? []) {
            const pid = (place.id as string) ?? '';
            if (pid && seen.has(pid)) continue;
            if (pid) seen.add(pid);
            const venue = toVenue(place);
            if (venue.name) venues.push(venue);
          }
          pageToken = resp.nextPageToken;
          if (!pageToken) break;
        } catch (err) {
          console.error(`google_places: query failed "${textQuery}":`, err);
          break;
        }
      }
    }

    console.log(`google_places: ${venues.length} venues`);
    return saveVenues(this.source, venues);
  }
}
