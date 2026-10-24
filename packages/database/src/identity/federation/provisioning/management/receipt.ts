import { z } from 'zod';

export const credentialReceipt = z.object({ credentialId: z.uuid() }).strict();
