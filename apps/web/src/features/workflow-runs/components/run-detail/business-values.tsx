import type { RunValues } from '@pertexo/node-sdk';
import { CopyButton } from '@/components/ui/copy-button';
import { Disclosure } from '@/components/ui/disclosure';
export function RunBusinessValues({
  values,
}: Readonly<{ values: RunValues | undefined }>) {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return null;
  return (
    <Disclosure
      summary="Saved run values"
      defaultOpen
      appearance={{ look: 'framed' }}
    >
      <dl className="grid gap-2 sm:grid-cols-2">
        {entries.map(([key, value]) => (
          <div
            key={key}
            className="flex min-w-0 items-start gap-2 rounded-md border border-border p-3"
          >
            <div className="min-w-0 flex-1">
              <dt className="font-mono text-xs break-all text-muted-foreground">
                {key}
              </dt>
              <dd className="mt-1 font-mono text-sm break-all whitespace-pre-wrap">
                {value === '' ? (
                  <span className="text-muted-foreground">Empty text</span>
                ) : (
                  value
                )}
              </dd>
            </div>
            <CopyButton value={value} label={`Copy ${key}`} />
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}
