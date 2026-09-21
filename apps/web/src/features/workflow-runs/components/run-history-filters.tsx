import {
  workflowRunListQuerySchema,
  workflowRunStatusSchema,
} from '@pertexo/contracts/schemas/workflow-runs';
import { useState, type SyntheticEvent } from 'react';
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
    const values = new FormData(event.currentTarget);
    const workflowId = formText(values, 'workflowId').trim();
    const workflowNamePrefix = formText(values, 'workflowNamePrefix').trim();
    const status = formText(values, 'status');
    const createdAtFrom = dateStart(formText(values, 'createdAtFrom'));
    const createdAtBefore = dateStart(formText(values, 'createdAtBefore'));
    const parsed = workflowRunListQuerySchema.safeParse({
      ...(workflowId === '' ? {} : { workflowId }),
      ...(workflowNamePrefix === '' ? {} : { workflowNamePrefix }),
      ...(status === '' ? {} : { status }),
      ...(createdAtFrom === undefined ? {} : { createdAtFrom }),
      ...(createdAtBefore === undefined ? {} : { createdAtBefore }),
    });
    if (!parsed.success) {
      setError(
        createdAtFrom !== undefined &&
          createdAtBefore !== undefined &&
          createdAtFrom >= createdAtBefore
          ? 'The before date must be later than the from date.'
          : 'Check the workflow ID and date filters.',
      );
      return;
    }
    setError(undefined);
    onApply({
      ...(parsed.data.workflowId === undefined
        ? {}
        : { workflowId: parsed.data.workflowId }),
      ...(parsed.data.workflowNamePrefix === undefined
        ? {}
        : { workflowNamePrefix: parsed.data.workflowNamePrefix }),
      ...(parsed.data.status === undefined
        ? {}
        : { status: parsed.data.status }),
      ...(parsed.data.createdAtFrom === undefined
        ? {}
        : { createdAtFrom: parsed.data.createdAtFrom }),
      ...(parsed.data.createdAtBefore === undefined
        ? {}
        : { createdAtBefore: parsed.data.createdAtBefore }),
    });
  }

  return (
    <form
      className="glass-panel mt-8 grid gap-4 rounded-xl p-4 lg:grid-cols-2 lg:items-end xl:grid-cols-3"
      onSubmit={submit}
    >
      {canFilterByWorkflowName ? (
        <Field>
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
            placeholder="e.g. Customer"
            autoComplete="off"
          />
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor="run-workflow-id">Workflow ID</FieldLabel>
        <Input
          id="run-workflow-id"
          name="workflowId"
          value={workflowId}
          onChange={(event) => {
            setWorkflowId(event.currentTarget.value);
          }}
          placeholder="Filter by exact workflow ID"
          autoComplete="off"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="run-status">Status</FieldLabel>
        <select
          id="run-status"
          name="status"
          value={status}
          onChange={(event) => {
            setStatus(event.currentTarget.value);
          }}
          className="recessed-control h-10 w-full rounded-lg border px-3 text-sm text-foreground"
        >
          <option value="">All statuses</option>
          {workflowRunStatusSchema.options.map((status) => (
            <option key={status} value={status}>
              {status.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
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
        <FieldLabel htmlFor="run-created-before">Created before</FieldLabel>
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
      <div className="flex gap-2">
        <Button type="submit" variant="outline">
          Apply
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setWorkflowId('');
            setWorkflowNamePrefix('');
            setStatus('');
            setCreatedAtFrom('');
            setCreatedAtBefore('');
            setError(undefined);
            onApply({});
          }}
        >
          Clear
        </Button>
      </div>
      {error === undefined ? null : (
        <p
          role="alert"
          className="text-sm text-destructive lg:col-span-2 xl:col-span-3"
        >
          {error}
        </p>
      )}
    </form>
  );
}

function dateStart(value: string): string | undefined {
  return value === '' ? undefined : `${value}T00:00:00.000Z`;
}

function dateValue(value: string | undefined): string {
  return value?.slice(0, 10) ?? '';
}

function formText(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === 'string' ? value : '';
}
