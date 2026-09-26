import { describe, expect, it } from 'vitest';
import {
  describeMisfirePolicy,
  describeRecurrence,
} from '@/features/catalog/presentation.public';
import {
  describeCron,
  describeInterval,
} from '@/features/catalog/schedule-sentence';

describe('schedule sentences', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['*/1 * * * *', 'Every minute'],
    ['5 * * * *', 'Every hour at :05'],
    ['0 */2 * * *', 'Every 2 hours at :00'],
    ['0 */1 * * *', 'Every hour at :00'],
    ['0 9 * * *', 'Every day at 9:00 AM'],
    ['0 9 * * 1-5', 'Every weekday at 9:00 AM'],
    ['30 7 * * MON-FRI', 'Every weekday at 7:30 AM'],
    ['0 9 * * 0,6', 'Every Saturday and Sunday at 9:00 AM'],
    ['0 9 * * 1,4', 'Every Monday and Thursday at 9:00 AM'],
    ['0 18 * * 7', 'Every Sunday at 6:00 PM'],
    ['0 9,17 * * *', 'Every day at 9:00 AM and 5:00 PM'],
    ['30 8 1 * *', 'On the 1st of every month at 8:30 AM'],
    ['0 9 1,15 * *', 'On the 1st and 15th of every month at 9:00 AM'],
    ['0 9 22 * *', 'On the 22nd of every month at 9:00 AM'],
    ['0 0 1 jan *', 'On the 1st of January at 12:00 AM'],
    ['0 9 * 6 1', 'Every Monday in June at 9:00 AM'],
    ['*/10 * * * 1-5', 'Every 10 minutes, every weekday'],
  ])('reads %s as “%s”', (expression, sentence) => {
    expect(describeCron(expression)).toBe(sentence);
  });

  it('names the expression when it can’t say it plainly', () => {
    expect(describeCron('0 9-17 * * *')).toBe(
      'On a custom schedule (0 9-17 * * *)',
    );
    expect(describeCron('15 14 1 * 1')).toBe(
      'On a custom schedule (15 14 1 * 1)',
    );
    expect(describeCron('61 * * * *')).toBe(
      'On a custom schedule (61 * * * *)',
    );
    expect(describeCron('* * *')).toBe('On a custom schedule (* * *)');
  });

  it('reads intervals in the largest whole unit', () => {
    expect(describeInterval(1)).toBe('Every minute');
    expect(describeInterval(90)).toBe('Every 90 minutes');
    expect(describeInterval(60)).toBe('Every hour');
    expect(describeInterval(1_440)).toBe('Every 24 hours');
    expect(describeInterval(4_320)).toBe('Every 3 days');
    expect(describeInterval(10_080)).toBe('Every week');
    expect(
      describeRecurrence({
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'Europe/Berlin',
      }),
    ).toBe('Every weekday at 9:00 AM');
  });

  it('explains what happens to a missed run', () => {
    expect(describeMisfirePolicy('catch_up_once')).toMatch(/runs once/u);
    expect(describeMisfirePolicy('skip')).toMatch(/skipped/u);
  });
});
