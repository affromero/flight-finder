import type { PushoverConfig } from '../types';

function key(config: Record<string, unknown>, field: string): string {
  const value = config[field];
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{30}$/.test(value)) {
    throw new Error(`config.${field} must be a 30-character Pushover key`);
  }
  return value;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`config.${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function validatePushoverConfig(config: Record<string, unknown>): PushoverConfig {
  const priority = integer(config.priority ?? 0, 'priority', -2, 2);
  const device = config.device;
  if (device != null && device !== '' && (typeof device !== 'string' || !/^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/.test(device) || device.length > 200 || device.split(',').some(name => name.length > 25))) {
    throw new Error('config.device must contain comma-separated Pushover device names of at most 25 characters each');
  }
  return {
    token: key(config, 'token'),
    userKey: key(config, 'userKey'),
    priority,
    ...(typeof device === 'string' && device ? { device } : {}),
    ...(priority === 2 ? {
      retry: integer(config.retry, 'retry', 30, 10800),
      expire: integer(config.expire, 'expire', 1, 10800),
    } : {}),
  };
}
