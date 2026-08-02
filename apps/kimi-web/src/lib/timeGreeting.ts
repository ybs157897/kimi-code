export type TimeGreetingPeriod =
  | 'earlyMorning'
  | 'morning'
  | 'noon'
  | 'afternoon'
  | 'evening'
  | 'lateNight';

/** Resolve a local clock hour to the empty-composer greeting period. */
export function timeGreetingPeriod(hour: number): TimeGreetingPeriod {
  if (hour >= 5 && hour < 9) return 'earlyMorning';
  if (hour >= 9 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'lateNight';
}
