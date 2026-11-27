const AFTERNOON_FROM_HOUR = 12;
const EVENING_FROM_HOUR = 18;

/** "Good afternoon, Dena." from the person's name and their local hour. */
export function homeGreeting(name: string | null, hour: number): string {
  const firstName = name?.trim().split(/\s+/u)[0] ?? '';
  let period = 'morning';
  if (hour >= EVENING_FROM_HOUR) period = 'evening';
  else if (hour >= AFTERNOON_FROM_HOUR) period = 'afternoon';
  return firstName === '' ? `Good ${period}.` : `Good ${period}, ${firstName}.`;
}
