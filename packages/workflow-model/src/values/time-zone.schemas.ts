import { z } from 'zod';

// Longer than any IANA zone name, short enough to store as an identifier.
const TIME_ZONE_NAME_CHARACTERS = 128;

export const ianaTimeZoneSchema = z
  .string()
  .min(1)
  .max(TIME_ZONE_NAME_CHARACTERS)
  .superRefine((zone, context) => {
    try {
      if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/u.test(zone))
        throw new RangeError();
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      context.addIssue({
        code: 'custom',
        message:
          'Use an IANA timezone such as Europe/Paris, America/New_York or UTC',
      });
    }
  })
  .meta({
    title: 'Time zone',
    description:
      'IANA name, such as Europe/Paris or America/New_York. UTC is explicit; the host timezone is never used.',
  });
