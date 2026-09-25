import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { describePreviewStatus } from '@/features/workflow-publish/public';
import { shortStepError } from '@/features/workflow-runs/failure.public';
import { formatDurationMs } from '@/lib/format-time';
import { useEditorStore } from '../../model/editor-store-context';
import { levelOf } from '../../model/graph-scopes';
import { describeTestPath } from '../../model/test-path';
import type { RecordedTest } from '../../use-last-test';

/**
 * The bar under the canvas after a step test: "Test passed", the path into
 * the tested step and how long the test took, and View output, which opens
 * that step's Test tab at its result. A test that didn't pass says so and
 * why. Everything comes from the test's answer and the graph. The next edit
 * to the draft puts it away.
 */
export function TestResultBar({
  test,
  onViewOutput,
}: Readonly<{
  test: RecordedTest | undefined;
  onViewOutput: (nodeId: string) => void;
}>) {
  const unchanged = useEditorStore(
    (state) => state.generation === test?.generation,
  );
  if (test === undefined || !unchanged) return null;
  return <TestResult test={test} onViewOutput={onViewOutput} />;
}

function TestResult({
  test,
  onViewOutput,
}: Readonly<{
  test: RecordedTest;
  onViewOutput: (nodeId: string) => void;
}>) {
  const graph = useEditorStore((state) => state.graph);
  const { preview, nodeId } = test;
  const status = describePreviewStatus(preview.status);
  const path = describeTestPath(levelOf(graph, nodeId) ?? graph, nodeId);
  const summary = [
    path,
    ...(preview.startedAt === null || preview.completedAt === null
      ? []
      : [
          formatDurationMs(
            Date.parse(preview.completedAt) - Date.parse(preview.startedAt),
          ),
        ]),
    ...(preview.safeErrorCode === null
      ? []
      : [shortStepError(preview.safeErrorCode)]),
  ].join(' · ');
  return (
    <section
      aria-label="Last test"
      className="lens pointer-events-auto flex min-h-12 flex-wrap items-center gap-x-3.5 gap-y-0.5 rounded-xl py-1.5 pr-1.5 pl-3.5"
    >
      <Status tone={status.tone} className="shrink-0">
        {status.label}
      </Status>
      {/* On phones the path takes its own line under the status. */}
      <p
        title={summary}
        className="order-last line-clamp-2 w-full min-w-0 pb-1 font-mono text-[0.72rem] leading-snug break-words text-subtle-foreground sm:order-none sm:w-auto sm:flex-1 sm:pb-0"
      >
        {summary}
      </p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="ml-auto shrink-0 sm:ml-0"
        onClick={() => {
          onViewOutput(nodeId);
        }}
      >
        {preview.output === null ? 'View details' : 'View output'}
      </Button>
    </section>
  );
}
