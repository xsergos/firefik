export function ruleLabel(rule: string | undefined): string {
  if (!rule) return "rule";
  if (rule === "default") return "default policy";
  if (rule === "host default") return "host · default policy";
  if (rule.startsWith("host ")) return `host · ${rule.slice(5)}`;
  return rule;
}

const HOUR_MS = 3_600_000;

export interface HourBucket {
  at: number;
  count: number | null;
}

export function hourlyBuckets(
  hourly: { at: string; count: number }[],
  hours: number,
  now: number,
): HourBucket[] {
  const byHour = new Map<number, number>();
  for (const h of hourly) {
    const t = Date.parse(h.at);
    if (Number.isNaN(t)) continue;
    const slot = Math.floor(t / HOUR_MS);
    byHour.set(slot, (byHour.get(slot) ?? 0) + h.count);
  }
  const last = Math.floor(now / HOUR_MS);
  const out: HourBucket[] = [];
  for (let slot = last - hours + 1; slot <= last; slot++) {
    const count = byHour.get(slot);
    out.push({ at: slot * HOUR_MS, count: count && count > 0 ? count : null });
  }
  return out;
}

export function bucketRange(buckets: HourBucket[]): { min: number; max: number } {
  if (buckets.length === 0) return { min: 0, max: 0 };
  let min = Infinity;
  let max = 0;
  for (const b of buckets) {
    const c = b.count ?? 0;
    if (c < min) min = c;
    if (c > max) max = c;
  }
  return { min, max };
}
