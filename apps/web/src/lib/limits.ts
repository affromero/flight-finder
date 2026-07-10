export const MAX_PRICE_VALUE = Number.MAX_SAFE_INTEGER;

export function isValidPriceAmount(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_PRICE_VALUE;
}
