import { useInfiniteQuery } from '@tanstack/react-query';
import { LoadMore } from '@/components/patterns/load-more';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { versionSourceWorkflowPageState } from '../../model/inspector/version-source-pagination';
import {
  workflowSourcesInfiniteQueryOptions,
  type VersionSourceScope,
} from '../../workflow-version-sources.queries';

export function WorkflowSourcePicker({
  scope,
  selected,
  onSelect,
}: Readonly<{
  scope: VersionSourceScope;
  selected: string | null;
  onSelect: (workflowId: string) => void;
}>) {
  const workflows = useInfiniteQuery(
    workflowSourcesInfiniteQueryOptions(scope),
  );
  const pages = workflows.data?.pages ?? [];
  const options = [
    ...new Map(
      pages
        .flatMap((page) => page.items)
        .map((workflow) => [workflow.id, workflow]),
    ).values(),
  ].map((workflow) => ({
    value: workflow.id,
    label: `${workflow.name} (${workflow.lifecycleStatus})`,
  }));
  const pageState = versionSourceWorkflowPageState(
    pages,
    workflows.data?.pageParams ?? [],
  );
  return (
    <FieldGroup className="gap-3">
      <LabelledField
        id="version-source-workflow"
        label="Workflow source"
        description="Workflows visible in this workspace. Choosing one only reads its published version source."
      >
        {(control) => (
          <Select
            items={options}
            value={selected}
            disabled={options.length === 0}
            onValueChange={(value) => {
              if (
                typeof value === 'string' &&
                options.some((option) => option.value === value)
              )
                onSelect(value);
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue placeholder="Choose a workflow to inspect" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      {workflows.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading workflow sources…
        </p>
      ) : null}
      {workflows.isError && !workflows.isFetchNextPageError ? (
        <Notice
          tone="destructive"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void workflows.refetch();
              }}
            >
              Retry workflow sources
            </Button>
          }
        >
          Workflow sources couldn’t be read. This is not evidence that a
          workflow is absent.
        </Notice>
      ) : null}
      {!workflows.isPending && !workflows.isError && options.length === 0 ? (
        <Notice>No workflows were returned for this workspace.</Notice>
      ) : null}
      {pageState.incomplete ? (
        <p className="text-sm text-muted-foreground">
          Only loaded workflow pages are shown; discovery is incomplete.
        </p>
      ) : null}
      {pageState.problem === undefined ? (
        <LoadMore
          subject="workflow sources"
          label="Load more workflow sources"
          hasNextPage={pageState.canLoadMore}
          loading={workflows.isFetching}
          failed={workflows.isFetchNextPageError}
          onLoadMore={() => {
            if (!workflows.isFetching && pageState.canLoadMore)
              void workflows.fetchNextPage();
          }}
        />
      ) : (
        <Notice tone="warning">
          {pageState.problem} Close and reopen to retry discovery.
        </Notice>
      )}
    </FieldGroup>
  );
}
