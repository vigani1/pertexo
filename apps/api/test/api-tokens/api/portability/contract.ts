import type { createTokenWorkspace } from './setup.js';

export type TokenWorkspace = Awaited<ReturnType<typeof createTokenWorkspace>>;
