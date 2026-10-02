export const CURATED_TEMPLATE_FIXTURE: Readonly<{
  httpEndpoint: string;
  httpAuthorization: string;
  slackBotToken: string;
  slackChannel: string;
  slackText: string;
}>;
export function createCuratedTemplateEnvelopeContext<Context extends object>(
  masterKeyHex: string,
): ReturnType<
  typeof import('./editor-browser-envelope-keys.mjs').createEditorBrowserEnvelopeKeys<Context>
>;
