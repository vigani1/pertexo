import { useId, useState } from 'react';
import type { WorkflowMoveReview } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Notice } from '@/components/ui/notice';
/** Mounted per review, so an acknowledgement never carries into a different move. */
export function AudienceMoveReview({
  report,
  administrator,
  pending,
  onConfirm,
  onCancel,
}: Readonly<{
  report: WorkflowMoveReview;
  administrator: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  const id = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const restrictions = [
    ...new Map(
      report.items
        .flatMap((item) => item.removedRestrictions)
        .map((folder) => [folder.id, folder]),
    ).values(),
  ];
  return (
    <section
      className="flex flex-col gap-3"
      aria-label="Review audience change"
    >
      <Notice
        tone="warning"
        title="This move changes who can access the workflows."
      >
        They will no longer inherit these folder restrictions. Their retained
        runs, files, tests and discussions move with them.
      </Notice>
      <ul
        className="list-inside list-disc text-sm"
        aria-label="Restrictions being removed"
      >
        {restrictions.map((folder) => (
          <li key={folder.id}>{folder.name}</li>
        ))}
      </ul>
      {administrator ? (
        <label htmlFor={id} className="flex items-start gap-2 text-sm">
          <Checkbox
            id={id}
            checked={acknowledged}
            disabled={pending}
            onCheckedChange={(checked) => {
              setAcknowledged(checked);
            }}
          />
          I reviewed the destination audience and accept this access change.
        </label>
      ) : (
        <p>Only an owner or admin can approve this audience change.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending || !administrator || !acknowledged}
          onClick={onConfirm}
        >
          Confirm move and audience change
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel move
        </Button>
      </div>
    </section>
  );
}
