import type { ModelUsage } from '@pertexo/node-sdk';
import { FORMAT_LOCALE } from '@/lib/format/locale';

export function ModelUsageDetails({ usage }: Readonly<{ usage: ModelUsage }>) {
  return (
    <div className="mt-2 text-xs">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Model</dt>
        <dd className="break-all">{usage.model}</dd>
        <dt className="text-muted-foreground">Input tokens</dt>
        <dd>
          {usage.inputTokens === null
            ? 'Unknown'
            : usage.inputTokens.toLocaleString(FORMAT_LOCALE)}
        </dd>
        <dt className="text-muted-foreground">Output tokens</dt>
        <dd>
          {usage.outputTokens === null
            ? 'Unknown'
            : usage.outputTokens.toLocaleString(FORMAT_LOCALE)}
        </dd>
      </dl>
      {usage.kind === 'incomplete' ? (
        <p className="mt-1 text-muted-foreground">Usage is incomplete.</p>
      ) : null}
    </div>
  );
}
