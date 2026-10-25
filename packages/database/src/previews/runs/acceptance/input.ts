import { z } from 'zod';

export const resultRefSchema = z.union([
  z.object({ outboxEventId: z.uuid(), previewAttemptId: z.uuid() }).strict(),
  z.object({ pinnedSampleId: z.uuid() }).strict(),
]);
