import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';

export function ExpiredAttemptNotice({
  onNewAttempt,
}: Readonly<{ onNewAttempt: () => void }>) {
  return (
    <Notice
      tone="warning"
      action={
        <Button type="button" variant="outline" onClick={onNewAttempt}>
          Start a new attempt
        </Button>
      }
    >
      The retry window ended. Check the current outcome before starting a new
      attempt; a new request may repeat the change.
    </Notice>
  );
}
