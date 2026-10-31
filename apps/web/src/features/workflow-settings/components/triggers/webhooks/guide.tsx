import type { WebhookAuthentication } from '@pertexo/contracts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  curlSnippet,
  NODE_SNIPPET,
  WEBHOOK_FRESHNESS,
  WEBHOOK_MAX_BODY,
} from '../../../model/triggers/webhook-snippets';
import { webhookAddressTemplate } from '../../../model/triggers/endpoint-key';
import { Disclosure } from '@/components/ui/disclosure';

const HEADERS = [
  ['Content-Type', 'application/json'],
  [
    'X-Pertexo-Timestamp',
    `The current Unix time in seconds. Deliveries older than ${WEBHOOK_FRESHNESS} are refused.`,
  ],
  [
    'X-Pertexo-Signature',
    'v1= followed by the hex HMAC-SHA256 of "<timestamp>.<raw body>", keyed with your signing secret decoded from base64url.',
  ],
  [
    'Idempotency-Key',
    'Optional. Send the same key when you retry, and Pertexo starts one run, not two.',
  ],
] as const;

function Snippet({ code }: Readonly<{ code: string }>) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border bg-recess-ink/35 p-3 font-mono text-[0.75rem] leading-relaxed text-muted-foreground">
      <code>{code}</code>
    </pre>
  );
}

/** How to send an event: headers, limits, and signed curl and Node examples. */
export function WebhookGuide({
  authentication,
}: Readonly<{ authentication: WebhookAuthentication }>) {
  return (
    <Disclosure
      summary="How to send events to this webhook"
      appearance={{ look: 'framed', tone: 'strong' }}
    >
      <div className="flex flex-col gap-4 border-t border-border px-3 py-4 text-sm">
        <p className="text-muted-foreground">
          {authentication.mode === 'signed'
            ? `Send a POST with a JSON, form or plain-text body of up to ${WEBHOOK_MAX_BODY} to the endpoint address. Each delivery starts one run.`
            : `Send a POST with a JSON, form or plain-text body of up to ${WEBHOOK_MAX_BODY}, or a GET with a query string, to the endpoint address. Each delivery starts one run.`}
        </p>
        {authentication.mode === 'signed' ? (
          <>
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
              {HEADERS.map(([name, meaning]) => (
                <div key={name} className="contents">
                  <dt className="font-mono text-xs text-foreground">{name}</dt>
                  <dd className="text-xs text-muted-foreground">{meaning}</dd>
                </div>
              ))}
            </dl>
            <Tabs defaultValue="curl">
              <TabsList aria-label="Example language">
                <TabsTrigger value="curl">curl</TabsTrigger>
                <TabsTrigger value="node">Node</TabsTrigger>
              </TabsList>
              <TabsContent value="curl" className="pt-3">
                <Snippet code={curlSnippet(webhookAddressTemplate())} />
              </TabsContent>
              <TabsContent value="node" className="pt-3">
                <Snippet code={NODE_SNIPPET} />
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              {authentication.mode === 'secret_url'
                ? 'Keep the entire address private: anyone with this URL can start runs.'
                : `Send the generated secret in ${authentication.headerName === 'authorization' ? 'Authorization: Bearer <header secret>' : `${authentication.headerName}: <header secret>`}. No Pertexo signature or timestamp is needed.`}
            </p>
            <Snippet
              code={[
                `curl -X POST '${webhookAddressTemplate()}' \\`,
                `  -H 'Content-Type: application/json' \\`,
                ...(authentication.mode === 'header_secret'
                  ? [
                      `  -H '${authentication.headerName}: ${authentication.headerName === 'authorization' ? 'Bearer ' : ''}<header secret>' \\`,
                    ]
                  : []),
                `  --data '{"event":"order.created"}'`,
              ].join('\n')}
            />
            <p className="text-xs text-muted-foreground">
              Send the same Idempotency-Key for retries. Browser origins
              allowed:{' '}
              {authentication.allowedOrigins.length === 0
                ? 'none'
                : authentication.allowedOrigins.join(', ')}
              . Browser callers use credentials: omit.
            </p>
          </>
        )}
      </div>
    </Disclosure>
  );
}
