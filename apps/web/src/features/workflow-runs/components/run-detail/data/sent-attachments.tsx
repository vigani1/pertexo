import { emailSendNotificationOutputSchema } from '@pertexo/integrations';
import { FileChip } from '@/features/artifacts/public';
import { formatByteLength } from '@/lib/format/bytes';
import { formatCount } from '@/lib/format/count';

/**
 * The files a Send email step attached, as the same chips the editor shows.
 * Names, types and sizes only: the step keeps no copy of what it sent.
 */
export function SentAttachments({ value }: Readonly<{ value: unknown }>) {
  const parsed = emailSendNotificationOutputSchema.safeParse(value);
  const attachments = parsed.success ? parsed.data.attachments : undefined;
  if (attachments === undefined) return null;
  const total = attachments.reduce(
    (bytes, attachment) => bytes + attachment.byteLength,
    0,
  );
  return (
    <section aria-label="Attachments sent" className="flex flex-col gap-2 pb-3">
      <p className="font-mono text-caption text-subtle-foreground tabular-nums">
        {formatCount(attachments.length, 'file')} sent ·{' '}
        {formatByteLength(total)}
      </p>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2">
        {attachments.map((attachment, index) => (
          <li key={`${String(index)}:${attachment.filename}`}>
            <FileChip
              name={attachment.filename}
              mediaType={attachment.mediaType}
              byteLength={attachment.byteLength}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
