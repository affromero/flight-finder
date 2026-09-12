import { optionalImportUrl } from '../travel/import-url';
import { CarError } from './types';

export function carImportUrl(raw: unknown, sources: readonly string[]): string | undefined {
  try { return optionalImportUrl(raw, 'cars', sources); }
  catch (error) { throw new CarError(error instanceof Error ? error.message : 'Invalid rental link'); }
}
