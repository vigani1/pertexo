import { z } from 'zod';

export interface Input {
  commandId: string;
  delivery: { outboxEventId: string; payloadChecksum: string };
  workspaceId: string;
  signal?: AbortSignal | undefined;
}

export const payloadSchema = z
  .object({
    commandId: z.uuid(),
    outboxEventId: z.uuid(),
    workspaceId: z.uuid(),
  })
  .strict();
