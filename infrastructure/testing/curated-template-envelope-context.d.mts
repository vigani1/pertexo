export const CURATED_TEMPLATE_FIXTURE: Readonly<{
  httpEndpoint: string;
  httpAuthorization: string;
  slackBotToken: string;
  slackChannel: string;
  slackText: string;
}>;
export function createCuratedTemplateEnvelopeContext<Context extends object>(
  masterKeyHex: string,
): ReturnType<typeof createEditorBrowserEnvelopeKeys<Context>>;
import type { createEditorBrowserEnvelopeKeys } from './editor-browser-envelope-keys.mjs';
