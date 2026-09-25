import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';

/** "Open run" for a trigger log entry that started one. */
export function RunLink({
  workspaceId,
  runId,
}: Readonly<{ workspaceId: string; runId: string }>) {
  return (
    <Link
      to="/w/$workspaceId/runs/$runId"
      params={{ workspaceId, runId }}
      className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
    >
      Open run
      <ArrowRightIcon aria-hidden="true" className="size-3" />
    </Link>
  );
}
