type AxisRange = [number, number];

/** Plotly date coordinates without an offset still represent UTC instants. */
function axisInstant(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return null;
  const iso = value.replace(' ', 'T');
  const epoch = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(epoch) ? epoch : null;
}

export function chartRangeChange(event: Record<string, unknown>): AxisRange | null | undefined {
  if (event['xaxis.autorange'] === true) return null;
  const range = event['xaxis.range'];
  const start = axisInstant(Array.isArray(range) ? range[0] : event['xaxis.range[0]']);
  const end = axisInstant(Array.isArray(range) ? range[1] : event['xaxis.range[1]']);
  if (start === null || end === null || start >= end) return undefined;
  return [start, end];
}

/** Labels localize instants without changing chronology across DST transitions. */
export function localAxisTicks(instants: readonly string[], range: AxisRange | null, timeZone?: string) {
  const epochs = instants.map(axisInstant).filter((value): value is number => value !== null);
  if (!epochs.length && !range) return { tickvals: [], ticktext: [] };
  const start = range?.[0] ?? epochs.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  const end = range?.[1] ?? epochs.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
  const tickvals = Array.from({ length: start === end ? 1 : 5 }, (_, index) => start + (end - start) * index / 4);
  const format = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZoneName: 'shortOffset', ...(timeZone ? { timeZone } : {}),
  });
  return {
    tickvals: tickvals.map(epoch => new Date(epoch).toISOString()),
    ticktext: tickvals.map(epoch => format.format(epoch).replace(', ', '<br>')),
  };
}
