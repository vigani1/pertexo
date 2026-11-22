import { Disclosure } from '@/components/ui/disclosure';
import {
  outputBranches,
  type BranchPorts,
} from '../../../model/step-inspection/branch-output';
import {
  DialogFooter,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  InlineFailedRead,
  QueryView,
} from '@/components/patterns/states/query-view';
import type { AccessibleWorkspace, WorkflowRunData } from '@pertexo/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import { Maximize2Icon } from 'lucide-react';
import { useState } from 'react';
import { JsonTree } from '@/components/patterns/code/json-tree';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { SkeletonLines } from '@/components/ui/skeleton';
import {
  ArtifactDownload,
  FilePages,
  ResponseFiles,
} from '@/features/artifacts/artifacts-views.public';
import { SentAttachments } from './sent-attachments';
import type { ApiClient } from '@/lib/api/client';
import {
  describeValue,
  isEmptyValue,
} from '../../../model/step-inspection/run-data-summary';
import { DATA_RETENTION_DAYS } from '@pertexo/workflow-model';
import { formatCount, pluralWord } from '@/lib/format/count';

export type RunDataScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  runId: string;
}>;

export function Muted({ children }: Readonly<{ children: string }>) {
  return <p className="text-label text-muted-foreground">{children}</p>;
}

/** Inline JSON: a tree to browse, with its size, Copy and a wider view. */
function InlineValue({
  value,
  title,
}: Readonly<{ value: unknown; title: string }>) {
  const [expanded, setExpanded] = useState(false);
  const summary = describeValue(value);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-caption text-subtle-foreground">
          {summary}
        </span>
        <div className="-mr-1.5 flex items-center">
          <CopyButton
            value={JSON.stringify(value, null, 2)}
            label={`Copy ${title}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Expand ${title}`}
            title="Expand"
            onClick={() => {
              setExpanded(true);
            }}
          >
            <Maximize2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>
      <JsonTree value={value} label={title} className="max-h-72" />
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-3xl">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
          <JsonTree
            value={value}
            label={title}
            className="mt-4 max-h-[60svh]"
          />
          <DialogFooter className="mt-4">
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Close
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One stored value: a tree of JSON, a file, or why there's nothing. */
export function RunDataValue({
  data,
  title,
  emptyText,
  scope,
}: Readonly<{
  data: WorkflowRunData;
  /** Names the value for Copy and Expand: "Data out of Set fields". */
  title: string;
  emptyText: string;
  scope: RunDataScope;
}>) {
  switch (data.kind) {
    case 'inline':
      return isEmptyValue(data.value) ? (
        <Muted>{emptyText}</Muted>
      ) : (
        <>
          {scope.workspace.capabilities.includes('artifact:read') ? (
            <>
              <ResponseFiles
                value={data.value}
                apiClient={scope.apiClient}
                userId={scope.userId}
                workspaceId={scope.workspace.id}
              />
              <FilePages
                value={data.value}
                apiClient={scope.apiClient}
                workspaceId={scope.workspace.id}
              />
            </>
          ) : null}
          <SentAttachments value={data.value} />
          <InlineValue value={data.value} title={title} />
        </>
      );
    case 'artifact':
      return scope.workspace.capabilities.includes('artifact:read') ? (
        <ArtifactDownload
          apiClient={scope.apiClient}
          userId={scope.userId}
          workspaceId={scope.workspace.id}
          artifactId={data.artifactId}
        />
      ) : (
        <Muted>This is a file, and your role can’t download files.</Muted>
      );
    case 'none':
      return <Muted>{emptyText}</Muted>;
    case 'expired':
      return (
        <Muted>{`No longer kept. Pertexo keeps run data for ${formatCount(DATA_RETENTION_DAYS.runDetails, 'day')}.`}</Muted>
      );
  }
}

/** A stored value being read: a quiet placeholder, then the value or a retry. */
export function RunDataRead({
  query,
  branchPorts,
  title,
  emptyText,
  scope,
}: Readonly<{
  query: UseQueryResult<WorkflowRunData>;
  branchPorts?: BranchPorts | undefined;
  title: string;
  emptyText: string;
  scope: RunDataScope;
}>) {
  return (
    <QueryView
      query={query}
      resource={title}
      loading={<SkeletonLines label={`Loading ${title}`} />}
      error={(failed) => (
        <InlineFailedRead text="Couldn’t load this." {...failed} />
      )}
    >
      {(data) => {
        const value = (
          <RunDataValue
            data={data}
            title={title}
            emptyText={emptyText}
            scope={scope}
          />
        );
        const branches = outputBranches(data, branchPorts);
        if (branches.length === 0) return value;
        return (
          <>
            <dl className="space-y-1 text-label">
              <dt className="text-subtle-foreground">
                {pluralWord(branches.length, 'Branch', 'Branches')}
              </dt>
              {branches.map(({ id, label }) => (
                <dd key={id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">{label}</span>
                  {label === id ? null : (
                    <code className="text-caption text-subtle-foreground">
                      {id}
                    </code>
                  )}
                </dd>
              ))}
            </dl>
            <Disclosure
              summary="Raw output"
              className="mt-3"
              appearance={{ size: 'xs' }}
            >
              {value}
            </Disclosure>
          </>
        );
      }}
    </QueryView>
  );
}
