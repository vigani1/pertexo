import { useState, useDeferredValue } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  PROMOTION_LIMITS,
  type WorkflowPromotionPreviewRequest,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Notice } from '@/components/ui/notice';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { PromotionScope } from '../data/promotions.api';
import {
  promotionCandidatesQuery,
  promotionVersionsQuery,
} from '../data/promotions.queries';
type Selections = WorkflowPromotionPreviewRequest['selections'];
export function PromotionSelection({
  scope,
  selections,
  locked,
  onChange,
}: {
  scope: PromotionScope;
  selections: Selections;
  locked: boolean;
  onChange: (value: Selections) => void;
}) {
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search);
  const candidates = useInfiniteQuery(
    promotionCandidatesQuery(scope, deferred),
  );
  return (
    <div className="grid gap-3">
      <label className="grid max-w-md gap-1 text-sm">
        Find published workflows
        <Input
          value={search}
          maxLength={128}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        Choose up to {String(PROMOTION_LIMITS.workflows)} workflows. A retained
        version stays selected until you change it.
      </p>
      <ul className="divide-y divide-border">
        {candidates.data?.pages
          .flatMap((page) => page.items)
          .map((workflow) => {
            const selected = selections.find(
              (item) => item.workflowId === workflow.workflowId,
            );
            return (
              <li
                key={workflow.workflowId}
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <label className="flex min-w-0 flex-1 items-center gap-3 text-sm">
                  <Checkbox
                    checked={selected !== undefined}
                    disabled={
                      locked ||
                      (selected === undefined &&
                        selections.length >= PROMOTION_LIMITS.workflows)
                    }
                    onCheckedChange={(checked) => {
                      onChange(
                        checked
                          ? [
                              ...selections,
                              {
                                workflowId: workflow.workflowId,
                                versionId: workflow.versionId,
                              },
                            ]
                          : selections.filter(
                              (item) => item.workflowId !== workflow.workflowId,
                            ),
                      );
                    }}
                  />
                  <span className="break-words">{workflow.name}</span>
                </label>
                {selected === undefined ? (
                  <span className="text-xs text-muted-foreground">
                    v{String(workflow.versionNumber)} live
                  </span>
                ) : (
                  <PromotionVersion
                    scope={scope}
                    workflowId={workflow.workflowId}
                    workflowName={workflow.name}
                    versionId={selected.versionId}
                    locked={locked}
                    onChange={(versionId) => {
                      onChange(
                        selections.map((item) =>
                          item.workflowId === workflow.workflowId
                            ? { ...item, versionId }
                            : item,
                        ),
                      );
                    }}
                  />
                )}
              </li>
            );
          })}
      </ul>
      {candidates.isPending ? (
        <p role="status">Loading published workflows…</p>
      ) : null}
      {candidates.isError ? (
        <Notice tone="warning">
          Published workflows could not be loaded.{' '}
          <Button variant="ghost" onClick={() => void candidates.refetch()}>
            Retry
          </Button>
        </Notice>
      ) : null}
      {candidates.data?.pages[0]?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No published workflows match.
        </p>
      ) : null}
      {candidates.hasNextPage ? (
        <Button
          variant="outline"
          className="self-start"
          disabled={candidates.isFetchingNextPage}
          onClick={() => void candidates.fetchNextPage()}
        >
          More workflows
        </Button>
      ) : null}
      {selections.length > 0 ? (
        <div className="flex items-center gap-3 text-sm">
          <span>{String(selections.length)} selected</span>
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => {
              onChange([]);
            }}
          >
            Clear selection
          </Button>
        </div>
      ) : null}
    </div>
  );
}
function PromotionVersion({
  scope,
  workflowId,
  workflowName,
  versionId,
  locked,
  onChange,
}: {
  scope: PromotionScope;
  workflowId: string;
  workflowName: string;
  versionId: string;
  locked: boolean;
  onChange: (value: string) => void;
}) {
  const versions = useInfiniteQuery(promotionVersionsQuery(scope, workflowId));
  const items = versions.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="w-40">
      <Select
        value={versionId}
        disabled={locked || versions.isPending}
        onValueChange={(value) => {
          if (value !== null) onChange(value);
        }}
      >
        <SelectTrigger aria-label={`Version for ${workflowName}`}>
          <SelectValue>
            {items.find((version) => version.versionId === versionId)
              ?.versionNumber === undefined
              ? 'Selected version'
              : `v${String(items.find((version) => version.versionId === versionId)?.versionNumber)}`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {items.map((version) => (
            <SelectItem key={version.versionId} value={version.versionId}>
              v{String(version.versionNumber)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {versions.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={locked || versions.isFetchingNextPage}
          onClick={() => void versions.fetchNextPage()}
        >
          Older versions
        </Button>
      ) : null}
      {versions.isError ? (
        <p className="text-xs text-warning">
          Versions unavailable. Your selection is kept.{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void versions.refetch()}
          >
            Retry versions
          </Button>
        </p>
      ) : null}
    </div>
  );
}
