import { UAParser } from 'ua-parser-js';
import { getRawDb } from './db';
import { generateVisitorId, generateSessionId } from './visitor-id';
import { lookupCountry } from '../country-lookup';

interface TrackParams {
  path: string;
  ip: string;
  userAgent: string;
  referrer?: string;
  botScore?: number;
}

function parseDevice(type: string | undefined): string {
  if (!type) return 'desktop';
  if (type === 'mobile') return 'mobile';
  if (type === 'tablet') return 'tablet';
  return 'desktop';
}

export function trackPageView({ path, ip, userAgent, referrer, botScore = 1 }: TrackParams): void {
  const parser = new UAParser(userAgent);
  const browser = parser.getBrowser().name || 'Unknown';
  const os = parser.getOS().name || 'Unknown';
  const device = parseDevice(parser.getDevice().type);

  const visitorId = generateVisitorId(ip, userAgent);
  const sessionId = generateSessionId(ip, userAgent);

  let country: string | null = null;
  try {
    country = lookupCountry(ip);
  } catch {
    // Country lookup is optional for analytics.
  }

  const db = getRawDb();
  db.prepare(
    `INSERT INTO page_events (timestamp, type, path, referrer, visitor_id, session_id, user_agent, browser, os, device, country, is_bot, bot_score)
     VALUES (?, 'pageview', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    path,
    referrer || null,
    visitorId,
    sessionId,
    userAgent,
    browser,
    os,
    device,
    country,
    botScore >= 2 ? 1 : 0,
    botScore,
  );
}

export function trackPageViewAsync(params: TrackParams): void {
  try {
    trackPageView(params);
  } catch (err) {
    console.error('[analytics] Failed to track page view:', err);
  }
}
