export const TIME_PREFERENCES = ['any', 'morning', 'afternoon', 'evening', 'redeye'] as const;
export type TimePreference = typeof TIME_PREFERENCES[number];

export function isTimePreference(value: unknown): value is TimePreference {
  return typeof value === 'string' && TIME_PREFERENCES.some((preference) => preference === value);
}

/** Airport-local clock minutes. Dates and timezone conversions do not apply. */
export function departureClockMinutes(value: string | null | undefined): number | null {
  const match = value?.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (meridiem) hour = hour % 12 + (meridiem === 'PM' ? 12 : 0);
  return hour * 60 + minute;
}

export function matchesDepartureWindow(value: string | null | undefined, preference: string | null | undefined): boolean {
  if (!preference || preference === 'any') return true;
  const minutes = departureClockMinutes(value);
  if (minutes === null) return false;
  switch (preference) {
    case 'morning': return minutes < 12 * 60;
    case 'afternoon': return minutes >= 12 * 60 && minutes <= 18 * 60;
    case 'evening': return minutes > 18 * 60;
    case 'redeye': return minutes >= 22 * 60;
    default: return false;
  }
}

export function departureCriteriaError(preference: unknown, strict: unknown): string | null {
  if (preference !== undefined && !isTimePreference(preference)) {
    return `timePreference must be one of: ${TIME_PREFERENCES.join(', ')}`;
  }
  if (strict !== undefined && typeof strict !== 'boolean') return 'strictDepartureTime must be a boolean';
  if (strict === true && (!preference || preference === 'any')) {
    return 'Strict departure filtering requires a named timePreference';
  }
  return null;
}
