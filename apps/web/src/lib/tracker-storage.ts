export interface SavedTracker {
  id: string;
  origin: string;
  destination: string;
  originName: string;
  destinationName: string;
  dateFrom: string;
  dateTo: string;
  createdAt: string;
  deleteToken?: string;
  label?: string;
}

export function getDeleteToken(id: string): string | null {
  const tracker = getSavedTrackers().find((t) => t.id === id);
  return tracker?.deleteToken ?? null;
}

// "ft-" prefix kept across the Flight Finder rename so existing browsers preserve state.
const STORAGE_KEY = 'ft-trackers';
const MAX_ENTRIES = 15;

export function getSavedTrackers(): SavedTracker[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedTracker[];
  } catch {
    return [];
  }
}

export function addSavedTracker(tracker: SavedTracker): void {
  if (typeof window === 'undefined') return;
  const existing = getSavedTrackers().filter((t) => t.id !== tracker.id);
  const updated = [tracker, ...existing].slice(0, MAX_ENTRIES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function removeSavedTracker(id: string): void {
  if (typeof window === 'undefined') return;
  const updated = getSavedTrackers().filter((t) => t.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}
