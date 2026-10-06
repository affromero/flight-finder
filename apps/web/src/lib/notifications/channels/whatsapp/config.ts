import type { WhatsAppConfig } from '../types';

function text(config: Record<string, unknown>, field: string, max = 200): string {
  const value = config[field];
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`config.${field} is invalid`);
  return value.trim();
}

export function validateWhatsAppConfig(config: Record<string, unknown>): WhatsAppConfig {
  const gatewayUrl = text(config, 'gatewayUrl', 2048);
  let gateway: URL;
  try { gateway = new URL(gatewayUrl); } catch { throw new Error('config.gatewayUrl is invalid'); }
  if (gatewayUrl.includes('?') || gatewayUrl.includes('#')) throw new Error('config.gatewayUrl cannot include a query or fragment');
  const apiKey = text(config, 'apiKey', 4096);
  if (!/^[\x20-\x7e]+$/.test(apiKey)) throw new Error('config.apiKey must contain printable ASCII characters');
  const destinationType = config.destinationType ?? 'phone';
  if (destinationType !== 'phone' && destinationType !== 'group') throw new Error('config.destinationType must be phone or group');
  const destination = text(config, 'destination');
  if (destinationType === 'phone' && !/^\+[1-9]\d{6,14}$/.test(destination)) throw new Error('config.destination must be an international phone number beginning with +');
  if (destinationType === 'group' && /\s/.test(destination)) throw new Error('config.destination must be a group identifier without spaces');
  const locale = config.locale ?? 'en';
  if (locale !== 'en' && locale !== 'es' && locale !== 'pt' && locale !== 'de' && locale !== 'fr') throw new Error('config.locale is unsupported');
  if (config.includeTrackerLink !== undefined && typeof config.includeTrackerLink !== 'boolean') throw new Error('config.includeTrackerLink must be a boolean');
  return { gatewayUrl: gateway.toString().replace(/\/+$/, ''), apiKey, account: text(config, 'account'), destinationType,
    destination, locale, includeTrackerLink: config.includeTrackerLink === true };
}
