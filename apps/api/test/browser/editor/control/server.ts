import { createServer } from 'node:http';

import { scenario } from '../fixture/environment.js';
import { fixtureState } from '../fixture/state.js';
import type { EditorBrowserJourneyContext } from '../fixture/contract.js';
import {
  handleEditorCallbackResume,
  handleEditorPortabilityDenial,
  handleEditorReadonlySetup,
  handleEditorScheduleRestart,
  handleEditorTaskExpiry,
} from './commands.js';
import {
  handleEditorOidcMetadata,
  handleEditorCuratedSeed,
  handleEditorPortabilitySeed,
  handleEditorVerificationLink,
  handleEditorNoticeMail,
  handleEditorEmailDeliveries,
} from './reads.js';
import {
  handleEditorBrowserReceipt,
  handleEditorEvidenceReceipt,
} from './receipts.js';

export function createEditorControlServer(
  context: EditorBrowserJourneyContext,
) {
  const { identityProvider } = context;

  // Separate loopback test-control listener for the local mail sink and
  // non-secret result IDs. This is never registered in the application API.
  const mailServer = createServer((request, response) => {
    if (scenario === 'federation' && identityProvider.handle(request, response))
      return;
    if (fixtureState.httpControl?.handle(request, response) === true) return;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (handleEditorCallbackResume({ context, request, response, url })) return;
    if (handleEditorTaskExpiry({ context, request, response, url })) return;

    if (handleEditorOidcMetadata({ context, request, response, url })) return;
    if (handleEditorCuratedSeed({ context, request, response, url })) return;
    if (handleEditorPortabilitySeed({ context, request, response, url }))
      return;
    if (handleEditorPortabilityDenial({ context, request, response, url }))
      return;
    if (handleEditorBrowserReceipt({ context, request, response, url })) return;
    if (handleEditorVerificationLink({ context, request, response, url }))
      return;
    if (handleEditorReadonlySetup({ context, request, response, url })) return;
    if (handleEditorScheduleRestart({ context, request, response, url }))
      return;
    if (handleEditorEvidenceReceipt({ context, request, response, url }))
      return;
    if (handleEditorNoticeMail({ context, request, response, url })) return;
    if (handleEditorEmailDeliveries({ context, request, response, url }))
      return;
    response.writeHead(404).end();
  });
  return mailServer;
}
