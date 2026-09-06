export const HOTEL_SOURCES = ['google_hotels', 'booking'] as const;
export type HotelSource = typeof HOTEL_SOURCES[number];
export const HOTEL_AMENITIES = ['parking', 'pool', 'pets', 'accessible'] as const;
export type HotelAmenity = typeof HOTEL_AMENITIES[number];
export interface HotelRoom { adults: number; children: number[] }
export interface HotelFilters {
  maxTotal: number | null;
  refundable: boolean;
  breakfast: boolean;
  minStars: number;
  minRating: number;
  excludedSellers: string[];
  amenities: HotelAmenity[];
}
export interface HotelSearch {
  destination: string;
  dateMode: 'fixed' | 'nearby' | 'window';
  checkIn: string;
  checkOut: string;
  flexibility: number;
  minNights: number;
  maxNights: number;
  rooms: HotelRoom[];
  currency: string;
  sources: HotelSource[];
  filters: HotelFilters;
}
export interface HotelStay { checkIn: string; checkOut: string }
export interface HotelOffer extends HotelStay {
  id: string;
  source: HotelSource;
  propertyId: string;
  hotelName: string;
  address: string;
  imageUrl: string | null;
  propertyUrl: string;
  bookingUrl: string;
  seller: string;
  roomName: string | null;
  rateName: string | null;
  providerRateId?: string;
  totalPrice: number;
  currency: string;
  taxesIncluded: boolean;
  occupancyVerified: boolean;
  rooms: HotelRoom[];
  refundable: boolean | null;
  breakfast: boolean | null;
  stars: number | null;
  rating: number | null;
  amenities: Partial<Record<HotelAmenity, boolean>>;
  match: 'exact' | 'approximate';
}
export interface HotelSourceError { source: HotelSource; checkIn: string; checkOut: string; message: string }
export interface HotelSearchResult { offers: HotelOffer[]; errors: HotelSourceError[]; completed: number; total: number }
export interface HotelSelection { propertyId: string; source: HotelSource; hotelName: string; propertyUrl: string; roomName: string | null; rateName: string | null; providerRateId?: string; seller: string; refundable: boolean | null; breakfast: boolean | null }
export interface HotelTrackingOptions {
  mode: 'best' | 'room';
  targetPrice: number | null;
  notifyLows: boolean;
  allowApproximateAlerts: boolean;
  scrapeInterval: number;
}
export const DEFAULT_HOTEL_FILTERS: HotelFilters = { maxTotal: null, refundable: false, breakfast: false, minStars: 0, minRating: 0, excludedSellers: [], amenities: [] };
