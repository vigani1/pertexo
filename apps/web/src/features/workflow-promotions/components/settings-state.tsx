import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
export function PromotionSettingsState({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <Notice tone={failed ? 'warning' : 'info'}>
      {failed
        ? 'Promotion settings could not be loaded.'
        : 'Loading promotion settings…'}
      {failed ? (
        <Button variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </Notice>
  );
}
