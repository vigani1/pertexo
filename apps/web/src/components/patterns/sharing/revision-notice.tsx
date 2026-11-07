import { ReadRecovery } from '@/components/patterns/states/read-recovery';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';

export function SharingRevisionNotice({
  latest,
  subject,
  canReview,
  locked,
  onReview,
  onReload,
  readFailure,
}: Readonly<{
  latest:
    | Readonly<{
        mode: 'workspace' | 'restricted';
        people: readonly Readonly<{ id: string; label: string }>[];
      }>
    | undefined;
  subject: string;
  canReview: boolean;
  locked: boolean;
  onReview: () => void;
  onReload: () => void;
  readFailure:
    | Readonly<{ error: unknown; retrying: boolean; retry: () => void }>
    | undefined;
}>) {
  return (
    <Notice
      tone="warning"
      action={
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canReview || locked}
            onClick={onReview}
          >
            Keep edits and use latest revision
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={onReload}
          >
            Discard edits and reload
          </Button>
        </div>
      }
    >
      Someone changed who can {subject} while you were editing. Review the
      current sharing before saving your edits, or choose Discard edits and
      reload to replace them.
      {readFailure === undefined ? null : (
        <ReadRecovery
          {...readFailure}
          resource="Current sharing"
          disabled={locked}
        />
      )}
      {latest === undefined && readFailure === undefined ? (
        <p>Loading current sharing…</p>
      ) : null}
      {latest === undefined ? null : (
        <section
          aria-label="Current saved sharing"
          className="mt-2 min-w-0 break-words"
        >
          <p>
            Current saved access:{' '}
            {latest.mode === 'workspace'
              ? 'Everyone in this workspace.'
              : 'Only chosen people.'}
          </p>
          {latest.mode === 'restricted' ? (
            <ul className="max-h-48 overflow-y-auto">
              {latest.people.map((person) => (
                <li key={person.id}>{person.label}</li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </Notice>
  );
}
