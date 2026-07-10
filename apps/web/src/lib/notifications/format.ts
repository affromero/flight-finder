import type { ChannelMessage } from './channels/types';
import type { NewLowAlert } from './detect';
import { safeHttpUrl } from '@/lib/safe-url';
import { formatCurrency } from '@/lib/currency';

export interface AlertRoute {
  origin: string;
  destination: string;
}

/** Build a channel-agnostic message for a new-low fare alert. `baseUrl` is null
 * when no public site URL is configured (self-hosted, unset), in which case the
 * message carries no chart link. */
export function formatNewLowMessage(params: {
  alert: NewLowAlert;
  route: AlertRoute;
  baseUrl: string | null;
}): ChannelMessage {
  const { alert, route, baseUrl } = params;
  const price = (n: number) => formatPrice(n, alert.currency);
  const chartUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/q/${alert.queryId}` : '';
  // Prefer the instance's own tracker page when a public URL is configured;
  // otherwise fall back to the fare's booking link so a self-hoster still gets
  // a tappable link with zero config. http(s) only (booking URLs are
  // LLM-extracted). Empty when neither exists — senders omit the link.
  const url = chartUrl || safeHttpUrl(alert.bookingUrl);
  const travelDate = alert.travelDate.toISOString().slice(0, 10);
  const lane = `${route.origin} to ${route.destination}`;
  const title = `New low: ${lane} ${price(alert.currentMin)}`;
  const body =
    `${lane} dropped to ${price(alert.currentMin)} on ${alert.airline} ` +
    `(was ${price(alert.baseline)}, down ${price(alert.drop)}). Travel date ${travelDate}.`;

  return {
    title,
    body,
    url,
    data: {
      queryId: alert.queryId,
      origin: route.origin,
      destination: route.destination,
      currentMin: alert.currentMin,
      baseline: alert.baseline,
      drop: alert.drop,
      currency: alert.currency,
      airline: alert.airline,
      travelDate,
      bookingUrl: alert.bookingUrl,
      chartUrl,
    },
  };
}

/** Format a price using the currency's locale rules, with a safe fallback. */
export function formatPrice(amount: number, currency: string | null): string {
  return formatCurrency(amount, currency);
}
