import type { HotelOffer } from './types';

export function hotelAmenities(text: string): HotelOffer['amenities'] {
  const amenities: HotelOffer['amenities'] = {};
  if (/no parking available|no parking facilities/i.test(text)) amenities.parking = false;
  else if (/(?:private|public|free|on-site|onsite) parking|\bParking(?:\s*\(\$\))?\n/i.test(text)) amenities.parking = true;
  if (/no (?:indoor |outdoor |swimming )?pool|pool (?:is )?not available/i.test(text)) amenities.pool = false;
  else if (/(?:indoor|outdoor|swimming) pool|\bPool\n/i.test(text)) amenities.pool = true;
  if (/pets are not allowed|pets not allowed/i.test(text)) amenities.pets = false;
  else if (!/pets (?:are )?allowed on request/i.test(text) && /pets are allowed|pet-friendly|pets allowed/i.test(text)) amenities.pets = true;
  if (/facilities for disabled guests|wheelchair accessible|\bAccessible\n/i.test(text)) amenities.accessible = true;
  return amenities;
}
