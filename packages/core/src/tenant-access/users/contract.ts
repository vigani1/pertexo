import type { ReplacementSessionInput } from '../contract.js';

export type AuthenticationReplacement = ReplacementSessionInput &
  Readonly<{ sourceSessionId: string }>;
