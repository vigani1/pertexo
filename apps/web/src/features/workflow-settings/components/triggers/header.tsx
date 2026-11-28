import { Link } from '@tanstack/react-router';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { buttonVariants } from '@/components/ui/button-variants';

/** What the tab is, and which published version its triggers come from. */
export function TriggersHeader({
  versions,
  publishedVersionId,
  runFromBuild,
}: Readonly<{
  versions:
    readonly Readonly<{ id: string; versionNumber: number }>[] | undefined;
  publishedVersionId: string | null | undefined;
  runFromBuild?: Readonly<{ workspaceId: string; workflowId: string }>;
}>) {
  const published = versions?.find(
    (version) => version.id === publishedVersionId,
  );
  return (
    <PageHeader>
      <div className="flex flex-col gap-2">
        <PageHeaderTitle size="section">Ways a run can start</PageHeaderTitle>
        <p className="text-meta text-subtle-foreground">
          {published === undefined
            ? 'From the published version.'
            : `From the published version, v${String(published.versionNumber)}.`}{' '}
          Pausing skips scheduled occurrences, refuses new webhook and form
          submissions, and stops polling and runs triggered by workflow
          failures. Run by hand and Test follow their usual availability.
        </p>
      </div>
      {runFromBuild === undefined || publishedVersionId == null ? null : (
        <PageHeaderActions>
          <Link
            to="/w/$workspaceId/workflows/$workflowId"
            params={runFromBuild}
            className={buttonVariants({ variant: 'outline' })}
          >
            Run in Build
          </Link>
        </PageHeaderActions>
      )}
    </PageHeader>
  );
}
