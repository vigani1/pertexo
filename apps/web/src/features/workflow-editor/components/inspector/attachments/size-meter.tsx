import { EMAIL_SEND_NOTIFICATION_LIMITS } from '@pertexo/integrations';
import { formatByteLength } from '@/lib/format/bytes';
import { cn } from '@/lib/utils';
import type { attachmentsSize } from '../../../model/inspector/object-mappings/attachments';

type Size = ReturnType<typeof attachmentsSize>;

function describe(size: Size): string {
  if (size.count === 0)
    return `No files · up to ${formatByteLength(size.limitBytes)}`;
  const files = `${String(size.count)} ${size.count === 1 ? 'file' : 'files'}`;
  const known = `${formatByteLength(size.bytes)} of ${formatByteLength(size.limitBytes)}`;
  if (size.unknown === 0) return `${files} · ${known}`;
  return `${files} · ${known} · ${String(size.unknown)} measured when sent`;
}

/**
 * A calm thread that fills toward the email's size limit. Fixed files have
 * known sizes; mapped ones trail as a dashed thread until the run measures
 * them. Base64 counts against the limit, so the fill uses encoded size.
 */
export function AttachmentSizeMeter({ size }: Readonly<{ size: Size }>) {
  const fill = Math.min(1, size.fraction);
  const text = describe(size);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="meter"
        aria-label="Attachment size"
        aria-valuemin={0}
        aria-valuemax={EMAIL_SEND_NOTIFICATION_LIMITS.maxAttachmentEncodedBytes}
        aria-valuenow={Math.round(
          fill * EMAIL_SEND_NOTIFICATION_LIMITS.maxAttachmentEncodedBytes,
        )}
        aria-valuetext={text}
        className="h-2 w-full px-[3px]"
      >
        <div className="relative size-full">
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-surface-ink/10"
          />
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-1/2 left-0 h-0.5 -translate-y-1/2 rounded-full transition-[width,background-color] duration-300 ease-unspool motion-reduce:transition-none',
              size.over && 'bg-destructive',
              !size.over && fill >= 0.8 && 'bg-warning',
              !size.over && fill < 0.8 && 'bg-accent-foreground/70',
            )}
            style={{ width: `${String(fill * 100)}%` }}
          />
          {size.count === 0 ? null : (
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left,background-color] duration-300 ease-unspool motion-reduce:transition-none',
                size.over ? 'bg-destructive' : 'bg-foreground/70',
              )}
              style={{ left: `${String(fill * 100)}%` }}
            />
          )}
          {size.unknown === 0 || size.over ? null : (
            <span
              aria-hidden="true"
              className="absolute top-1/2 h-0.5 w-10 -translate-y-1/2 bg-[repeating-linear-gradient(90deg,var(--subtle-foreground)_0_3px,transparent_3px_7px)] opacity-60"
              style={{
                left: `min(calc(${String(fill * 100)}% + 0.375rem), calc(100% - 2.5rem))`,
              }}
            />
          )}
        </div>
      </div>
      <p
        className={cn(
          'font-mono text-[0.66rem] leading-none tabular-nums',
          size.over ? 'text-destructive' : 'text-subtle-foreground',
        )}
      >
        {text}
      </p>
    </div>
  );
}
