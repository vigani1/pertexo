import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';

export function SharingRevisionNotice({
  subject,
  canReview,
  locked,
  onReview,
  onReload,
}: Readonly<{
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
    </Notice>
  );
}
