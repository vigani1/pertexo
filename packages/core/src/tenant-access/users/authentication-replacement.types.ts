import type { ReplacementSessionInput } from '../tenant-access.types.js';

export type AuthenticationReplacement = ReplacementSessionInput &
  Readonly<{ sourceSessionId: string }>;
