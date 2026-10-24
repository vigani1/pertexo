import type { createBrowserIdentityProvider } from '../federation/provider.js';

import type { useBetterAuthRealApi } from '../../../support/better-auth/real-api.support.js';

import type { createEditorBrowserFixture } from './setup.js';

export type EditorBrowserApi = ReturnType<typeof useBetterAuthRealApi>;

export interface EditorBrowserJourneyContext {
  readonly fixture: ReturnType<typeof createEditorBrowserFixture>;
  readonly api: EditorBrowserApi;
  readonly apiOrigin: string;
  readonly identityProvider: ReturnType<typeof createBrowserIdentityProvider>;
}
