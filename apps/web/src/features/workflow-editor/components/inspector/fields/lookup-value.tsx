import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type {
  ConnectionLookupRequest,
  ConnectionLookupResponse,
} from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { connectionOptions } from '@/features/connections/connections-queries.public';
import type { FieldParseResult } from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { useInspectorDraftField } from '../../../hooks/inspector/use-draft-field';

type LookupItem = ConnectionLookupResponse['items'][number];
type Feedback = Readonly<{
  label: string | undefined;
  note: string | undefined;
}>;

/** A literal input with a display label resolved after the editor leaves the field. */
export function LookupValueField({
  field,
  value,
  connectionId,
  scope,
  form,
  lookup,
  parse,
  commit,
  describe,
}: Readonly<{
  field: Readonly<{
    key: string;
    name: string;
    label: string;
    description: string;
    needsConnection: string;
  }>;
  value: string | undefined;
  connectionId: string | undefined;
  scope: NonNullable<NodeFormApi['lookup']>['scope'];
  form: NodeFormApi;
  lookup(value: string): ConnectionLookupRequest;
  parse(text: string): FieldParseResult<string | undefined>;
  commit(value: string | undefined): void;
  describe(
    value: string,
    item: LookupItem | undefined,
    failed: boolean,
  ): Feedback;
}>) {
  const id = fieldControlId(form.nodeId, field.key);
  const nameId = `${id}-name`;
  const [editing, setEditing] = useState(false);
  const live = useInspectorDraftField({
    value,
    format: (current) => current ?? '',
    parse,
    commit,
    onScratchChange: (scratch) => {
      form.reportScratch(field.key, scratch);
    },
  });
  const requested = editing ? undefined : value;
  const queries: ReturnType<typeof connectionOptions>[] =
    requested === undefined || connectionId === undefined || !scope.enabled
      ? []
      : [
          connectionOptions({
            ...scope,
            connectionId,
            request: lookup(requested),
            freshness: 'catalog',
          }),
        ];
  const [result] = useQueries({ queries });
  const item = result?.data?.items.find((item) => item.value === requested);
  const feedback =
    requested === undefined || result === undefined
      ? undefined
      : describe(requested, item, result.isError);
  const note =
    requested !== undefined && connectionId === undefined
      ? field.needsConnection
      : feedback?.note;
  const pendingLabel = result?.isPending ? 'Looking up…' : null;

  return (
    <LabelledField
      id={id}
      label={field.label}
      description={field.description}
      error={live.error}
      describedBy={nameId}
      slots={{
        feedback:
          note === undefined ? null : (
            <p className="text-xs text-muted-foreground">{note}</p>
          ),
      }}
    >
      {(control) => (
        <div className="flex items-center gap-2">
          <Input
            {...control}
            name={field.name}
            autoComplete="off"
            spellCheck={false}
            typography="mono"
            className="flex-1"
            value={live.text}
            disabled={!form.editable}
            onBlur={() => {
              setEditing(false);
              live.blur();
            }}
            onChange={(event) => {
              setEditing(true);
              live.change(event.currentTarget.value);
            }}
          />
          <span
            id={nameId}
            aria-live="polite"
            className="max-w-[45%] shrink-0 truncate font-mono text-xs text-muted-foreground"
          >
            {feedback?.label === undefined ? (
              pendingLabel
            ) : (
              <span className="text-foreground">{feedback.label}</span>
            )}
          </span>
        </div>
      )}
    </LabelledField>
  );
}
