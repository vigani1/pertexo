import {
  workflowRunListQuerySchema,
  workflowRunStatusSchema,
} from '@pertexo/contracts/schemas/workflow-runs';
import { ChevronDownIcon, XIcon } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { RunHistoryFilters } from '../run-history.types';

export function RunHistoryFiltersForm({
  filters,
  canFilterByWorkflowName,
  onApply,
}: Readonly<{
  filters: RunHistoryFilters;
  canFilterByWorkflowName: boolean;
  onApply: (filters: RunHistoryFilters) => void;
}>) {
  const [advancedOpen, setAdvancedOpen] = useState(
    filters.workflowId !== undefined ||
      filters.createdAtFrom !== undefined ||
      filters.createdAtBefore !== undefined,
  );
  const [error, setError] = useState<string>();
  const [workflowId, setWorkflowId] = useState(filters.workflowId ?? '');
  const [workflowNamePrefix, setWorkflowNamePrefix] = useState(
    filters.workflowNamePrefix ?? '',
  );
  const [status, setStatus] = useState(filters.status ?? '');
  const [createdAtFrom, setCreatedAtFrom] = useState(() =>
    dateValue(filters.createdAtFrom),
  );
  const [createdAtBefore, setCreatedAtBefore] = useState(() =>
    dateValue(filters.createdAtBefore),
  );

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseFilters({
      workflowId,
      workflowNamePrefix,
      status,
      createdAtFrom,
      createdAtBefore,
    });
    if (!parsed.success) {
      setAdvancedOpen(true);
      setError(parsed.message);
      return;
    }
    setError(undefined);
    onApply(parsed.filters);
  }

  function clear() {
    setWorkflowId('');
    setWorkflowNamePrefix('');
    setStatus('');
    setCreatedAtFrom('');
    setCreatedAtBefore('');
    setError(undefined);
    setAdvancedOpen(false);
    onApply({});
  }

  function removeFilter(key: keyof RunHistoryFilters) {
    onApply(
      Object.fromEntries(
        Object.entries(filters).filter(([entryKey]) => entryKey !== key),
      ),
    );
  }

  return (
    <div className="border-b">
      <form onSubmit={submit}>
        <div className="flex flex-col gap-3 px-4 py-4 sm:px-5 lg:flex-row lg:items-end">
          {canFilterByWorkflowName ? (
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor="run-workflow-name">
                Workflow name starts with
              </FieldLabel>
              <Input
                id="run-workflow-name"
                name="workflowNamePrefix"
                value={workflowNamePrefix}
                onChange={(event) => {
                  setWorkflowNamePrefix(event.currentTarget.value);
                }}
                placeholder="e.g. Customer…"
                autoComplete="off"
              />
            </Field>
          ) : null}
          <Field className="w-full lg:w-48">
            <FieldLabel htmlFor="run-status">Status</FieldLabel>
            <select
              id="run-status"
              name="status"
              value={status}
              onChange={(event) => {
                setStatus(event.currentTarget.value);
              }}
              className="recessed-control h-10 w-full rounded-lg border px-3 text-base text-foreground"
            >
              <option value="">All statuses</option>
              {workflowRunStatusSchema.options.map((option) => (
                <option key={option} value={option}>
                  {option.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline">
              Apply
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-expanded={advancedOpen}
              aria-controls="run-advanced-filters"
              onClick={() => {
                setAdvancedOpen((open) => !open);
              }}
            >
              Add filters
              <ChevronDownIcon
                aria-hidden="true"
                className={advancedOpen ? 'rotate-180' : undefined}
              />
            </Button>
            <Button type="button" variant="ghost" onClick={clear}>
              Clear
            </Button>
          </div>
        </div>

        {advancedOpen ? (
          <div
            id="run-advanced-filters"
            className="grid gap-4 border-t bg-black/10 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-3"
          >
            <Field>
              <FieldLabel htmlFor="run-workflow-id">Workflow ID</FieldLabel>
              <Input
                id="run-workflow-id"
                name="workflowId"
                value={workflowId}
                onChange={(event) => {
                  setWorkflowId(event.currentTarget.value);
                }}
                placeholder="Exact workflow ID"
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="run-created-from">Created from</FieldLabel>
              <Input
                id="run-created-from"
                name="createdAtFrom"
                type="date"
                value={createdAtFrom}
                onChange={(event) => {
                  setCreatedAtFrom(event.currentTarget.value);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="run-created-before">
                Created before
              </FieldLabel>
              <Input
                id="run-created-before"
                name="createdAtBefore"
                type="date"
                value={createdAtBefore}
                onChange={(event) => {
                  setCreatedAtBefore(event.currentTarget.value);
                }}
              />
            </Field>
          </div>
        ) : null}

        {error === undefined ? null : (
          <p
            role="alert"
            className="border-t px-4 py-3 text-sm text-destructive sm:px-5"
          >
            {error}
          </p>
        )}
      </form>
      <AppliedRunFilters filters={filters} onRemove={removeFilter} />
    </div>
  );
}

function AppliedRunFilters({
  filters,
  onRemove,
}: Readonly<{
  filters: RunHistoryFilters;
  onRemove: (key: keyof RunHistoryFilters) => void;
}>) {
  const entries = appliedFilterEntries(filters);
  if (entries.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t px-4 py-3 sm:px-5"
      aria-label="Applied run filters"
    >
      <span className="text-xs text-muted-foreground">Applied</span>
      {entries.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="min-w-0 max-w-full rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={`Remove filter ${label}`}
          title={label}
          onClick={() => {
            onRemove(key);
          }}
        >
          <Badge
            variant="default"
            className="flex max-w-full min-w-0 gap-1.5 py-1"
          >
            <span className="min-w-0 truncate">{label}</span>
            <XIcon aria-hidden="true" className="size-3 shrink-0" />
          </Badge>
        </button>
      ))}
    </div>
  );
}

function appliedFilterEntries(
  filters: RunHistoryFilters,
): [keyof RunHistoryFilters, string][] {
  const entries: [keyof RunHistoryFilters, string][] = [];
  if (filters.workflowNamePrefix !== undefined)
    entries.push(['workflowNamePrefix', `Name: ${filters.workflowNamePrefix}`]);
  if (filters.status !== undefined)
    entries.push(['status', `Status: ${filters.status.replaceAll('_', ' ')}`]);
  if (filters.workflowId !== undefined)
    entries.push(['workflowId', `Workflow: ${filters.workflowId}`]);
  if (filters.createdAtFrom !== undefined)
    entries.push([
      'createdAtFrom',
      `From: ${dateValue(filters.createdAtFrom)}`,
    ]);
  if (filters.createdAtBefore !== undefined)
    entries.push([
      'createdAtBefore',
      `Before: ${dateValue(filters.createdAtBefore)}`,
    ]);
  return entries;
}

function parseFilters(
  values: Readonly<{
    workflowId: string;
    workflowNamePrefix: string;
    status: string;
    createdAtFrom: string;
    createdAtBefore: string;
  }>,
):
  | Readonly<{ success: true; filters: RunHistoryFilters }>
  | Readonly<{ success: false; message: string }> {
  const workflowId = values.workflowId.trim();
  const workflowNamePrefix = values.workflowNamePrefix.trim();
  const createdAtFrom = dateStart(values.createdAtFrom);
  const createdAtBefore = dateStart(values.createdAtBefore);
  const parsed = workflowRunListQuerySchema.safeParse({
    ...(workflowId === '' ? {} : { workflowId }),
    ...(workflowNamePrefix === '' ? {} : { workflowNamePrefix }),
    ...(values.status === '' ? {} : { status: values.status }),
    ...(createdAtFrom === undefined ? {} : { createdAtFrom }),
    ...(createdAtBefore === undefined ? {} : { createdAtBefore }),
  });
  if (!parsed.success)
    return {
      success: false,
      message:
        createdAtFrom !== undefined &&
        createdAtBefore !== undefined &&
        createdAtFrom >= createdAtBefore
          ? 'The before date must be later than the from date.'
          : 'Check the workflow ID and date filters.',
    };
  return { success: true, filters: parsed.data };
}

function dateStart(value: string): string | undefined {
  return value === '' ? undefined : `${value}T00:00:00.000Z`;
}

function dateValue(value: string | undefined): string {
  return value?.slice(0, 10) ?? '';
}
