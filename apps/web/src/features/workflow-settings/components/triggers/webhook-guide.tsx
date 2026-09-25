import { ChevronRightIcon } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  CURL_SNIPPET,
  NODE_SNIPPET,
  WEBHOOK_FRESHNESS,
  WEBHOOK_MAX_BODY,
} from '../../model/webhook-snippets';

const HEADERS = [
  ['Content-Type', 'application/json'],
  [
    'X-Pertexo-Timestamp',
    `The current Unix time in seconds. Deliveries older than ${WEBHOOK_FRESHNESS} are refused.`,
  ],
  [
    'X-Pertexo-Signature',
    'v1= followed by the hex HMAC-SHA256 of "<timestamp>.<raw body>", keyed with your signing secret.',
  ],
  [
    'Idempotency-Key',
    'Optional. Send the same key when you retry, and Pertexo starts one run, not two.',
  ],
] as const;

function Snippet({ code }: Readonly<{ code: string }>) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border bg-black/35 p-3 font-mono text-[0.75rem] leading-relaxed text-muted-foreground">
      <code>{code}</code>
    </pre>
  );
}

/** How to send an event: headers, limits, and signed curl and Node examples. */
export function WebhookGuide() {
  return (
    <details className="group/guide rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium text-muted-foreground outline-none select-none hover:text-foreground focus-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 transition-transform duration-150 group-open/guide:rotate-90 motion-reduce:transition-none"
        />
        How to send events to this webhook
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-3 py-4 text-sm">
        <p className="text-muted-foreground">
          Send a POST with a JSON body of up to {WEBHOOK_MAX_BODY} to the
          endpoint address. Each delivery starts one run.
        </p>
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
            <Snippet code={CURL_SNIPPET} />
          </TabsContent>
          <TabsContent value="node" className="pt-3">
            <Snippet code={NODE_SNIPPET} />
          </TabsContent>
        </Tabs>
      </div>
    </details>
  );
}
