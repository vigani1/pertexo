import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
export function ProviderRevisionNotice({
  locked,
  canReview,
  onKeepEdits,
  onReload,
}: Readonly<{
  locked: boolean;
  canReview: boolean;
  onKeepEdits: () => void;
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
            disabled={locked || !canReview}
            onClick={onKeepEdits}
          >
            Keep edits and use latest revision
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={onReload}
          >
            Reload provider
          </Button>
        </div>
      }
    >
      Organization settings changed. Your edits are kept. Reloading replaces
      this form with the current settings.
    </Notice>
  );
}
