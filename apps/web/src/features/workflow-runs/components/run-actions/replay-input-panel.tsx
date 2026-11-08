import type { UseQueryResult } from '@tanstack/react-query';
import type { WorkflowRunData } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { Notice } from '@/components/ui/notice';
import { ReadRecovery } from '@/components/patterns/states/read-recovery';
import type { useRunInput } from '../../hooks/use-run-input';
import { RunInputFields } from '../run-input-fields';

export function ReplayInputPanel({
  original,
  runInput,
  locked,
  formReplay,
  workspaceId,
  workflowId,
}: Readonly<{
  original: UseQueryResult<WorkflowRunData>;
  runInput: ReturnType<typeof useRunInput>;
  locked: boolean;
  formReplay: boolean;
  workspaceId: string;
  workflowId: string;
}>) {
  return (
    <>
      {original.isError ? (
        <ReadRecovery
          error={original.error}
          resource="saved run input"
          retrying={original.isFetching}
          retry={() => {
            void original.refetch();
          }}
          label="Retry saved input"
        />
      ) : null}
      <p className="text-sm text-muted-foreground">
        Replay keeps the source run’s workspace variables. Start a new run to
        use current values.
      </p>
      <RunInputFields
        idPrefix="replay-run"
        inputLabel="Replay input (JSON)"
        runInput={runInput}
        disabled={locked}
        inputReadOnly={formReplay}
      />
      {formReplay ? (
        <Notice
          action={
            <Link
              to="/w/$workspaceId/forms/$workflowId"
              params={{ workspaceId, workflowId }}
              className="underline underline-offset-4"
            >
              Open workflow form
            </Link>
          }
        >
          The original fields, submitter and submission time stay fixed. If the
          captured input expired, send a new response.
        </Notice>
      ) : null}
    </>
  );
}
