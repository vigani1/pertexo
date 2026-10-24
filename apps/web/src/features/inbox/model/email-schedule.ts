import {
  noticeDefaultsRequestSchema,
  type NoticePreferencesResponse,
  type NoticePreferencesRequest,
} from '@pertexo/contracts';

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

export type ScheduleTarget = 'personal' | 'defaults';
/** A late acknowledgement cannot replace a newer schedule already displayed. */
export function acceptedNotificationSchedule(
  current: NoticePreferencesResponse | undefined,
  {
    target,
    body,
    result,
  }: Readonly<{
    target: ScheduleTarget;
    body: NoticePreferencesRequest;
    result: Readonly<{ revision: number }>;
  }>,
): NoticePreferencesResponse | undefined {
  if (current === undefined) return current;
  const previous =
    target === 'personal' ? current.revision : current.defaults.revision;
  if (previous > result.revision) return current;
  if (target === 'personal') {
    const personal = {
      mode: body.mode,
      hour: body.hour,
      timeZone: body.timeZone,
      revision: result.revision,
    };
    return {
      ...current,
      ...personal,
      effective:
        body.mode === null
          ? {
              mode: current.defaults.mode,
              hour: current.defaults.hour,
              timeZone: current.defaults.timeZone,
            }
          : {
              mode: body.mode,
              hour: body.hour,
              timeZone: body.timeZone,
            },
    };
  }
  const accepted = noticeDefaultsRequestSchema.parse(body);
  const defaults = {
    mode: accepted.mode,
    hour: accepted.hour,
    timeZone: accepted.timeZone,
    revision: result.revision,
  };
  return {
    ...current,
    defaults,
    effective:
      current.mode === null
        ? {
            mode: defaults.mode,
            hour: defaults.hour,
            timeZone: defaults.timeZone,
          }
        : current.effective,
  };
}
