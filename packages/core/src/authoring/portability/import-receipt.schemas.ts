import { z } from 'zod';

// Command receipts are untrusted stored JSON.
export const importResultSchema = z.object({ workflowId: z.uuid() }).strict();
