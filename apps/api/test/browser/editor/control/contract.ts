import type { IncomingMessage, ServerResponse } from 'node:http';

import type { EditorBrowserJourneyContext } from '../fixture/contract.js';

export interface EditorControlRequest {
  readonly context: EditorBrowserJourneyContext;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
}
