import type { NoticePreferencesResponse } from '@pertexo/contracts';

type Schedule = NoticePreferencesResponse['effective'];

/** "Hourly digest", "Daily at 9:00, Europe/Paris": a schedule in words. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.mode) {
    case 'off':
      return 'Off';
    case 'immediate':
      return 'Within a minute';
    case 'hourly':
      return 'Hourly digest';
    case 'daily':
      return `Daily at ${String(schedule.hour).padStart(2, '0')}:00, ${schedule.timeZone}`;
  }
}

/** The person's own choice in a sentence, saying when it follows the default. */
export function describePersonalChoice(
  snapshot: NoticePreferencesResponse,
): string {
  if (snapshot.mode === null)
    return `You follow the workspace default: ${describeSchedule(snapshot.defaults).toLowerCase()}.`;
  return snapshot.mode === 'off'
    ? 'You get no email; everything waits in your Inbox.'
    : `You chose: ${describeSchedule(snapshot.effective).toLowerCase()}.`;
}
