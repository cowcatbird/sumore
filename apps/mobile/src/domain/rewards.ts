import type { CircleShop } from './circle-shop';

export const SMORE_REWARD_EXPLANATION = 'Your circle earns one s’more when everyone goes a full day without asking for time.';

export function sMoreRewardLabel(count: number) {
  return `${count} circle ${count === 1 ? 's’more' : 's’mores'}`;
}

/** Display only: group midnight boundaries come from the server, which alone
 * awards coins. A phone's timezone or clock rollover never changes the wallet. */
export function nextSMoreProgress(shop: CircleShop | undefined, now = new Date()) {
  const loading = { fraction: 0, label: 'Refreshing circle…', state: 'loading' as const };
  if (!shop) return loading;
  const start = Date.parse(shop.dayStartedAt);
  const end = Date.parse(shop.nextAwardAt);
  const time = now.getTime();
  if (![start, end, time].every(Number.isFinite) || end <= start || time < start || time >= end) return loading;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: shop.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDate = (value: Date) => {
      const parts = formatter.formatToParts(value);
      return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
    };
    // Do not show yesterday's asks or invent a new clean day while offline.
    if (localDate(now) !== shop.localDate || localDate(new Date(start)) !== shop.localDate) return loading;
  } catch {
    return loading;
  }
  if (!shop.eligibleToday) return { fraction: 0, label: 'Starts tomorrow', state: 'waiting' as const };
  if (shop.askedToday) return { fraction: 0, label: 'Fresh start tomorrow', state: 'burnt' as const };
  // The server's exact boundaries also handle 23- and 25-hour DST days.
  const fraction = Math.max(0, Math.min(0.999, (time - start) / (end - start)));
  return { fraction, label: 'Keep the whole circle request-free', state: 'earning' as const };
}
