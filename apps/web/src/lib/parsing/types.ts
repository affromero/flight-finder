import type { ParseResponse } from '../scraper/parse-query';

export interface ParseJobStatus {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  expiresAt: string;
  result?: ParseResponse;
  error?: string;
  capability?: string;
}

export class ParseJobError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ParseJobError'; }
}

export const PARSE_JOB_TTL_MS = 24 * 60 * 60 * 1000;
export const PARSE_QUEUE_MS = 10 * 60 * 1000;
export const PARSE_LEASE_MS = 15_000;
export const PARSE_MAX_RUNNING = 2;
export const PARSE_MAX_QUEUED = 32;
