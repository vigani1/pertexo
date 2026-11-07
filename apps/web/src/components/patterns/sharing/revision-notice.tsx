import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';

export function SharingRevisionNotice({
  latest,
  subject,
  canReview,
  locked,
  onReview,
  onReload,
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
            Reload
          </Button>
        </div>
      }
    >
      Someone changed who can {subject} while you were editing. Review the
      current sharing before saving your edits, or reload to replace them.
      {latest === undefined ? (
        <p>The current sharing could not be loaded. Reload before saving.</p>
      ) : (
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
