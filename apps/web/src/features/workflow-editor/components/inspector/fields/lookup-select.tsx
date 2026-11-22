import { useQuery } from '@tanstack/react-query';
import type {
  ConnectionLookupField,
  ConnectionLookupResponse,
} from '@pertexo/contracts';
import { canonicalJson } from '@pertexo/workflow-model';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  withFieldValue,
  type NodeConfig,
  type SchemaFieldSpec,
} from '../../../model/inspector/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { connectionOptions } from '../../../data/connection-options.queries';
import { ChoiceSelect } from './choice-select';

type LookupSelectProps = Readonly<{
  id: string;
  field: SchemaFieldSpec;
  lookup: ConnectionLookupField;
  config: NodeConfig;
  form: NodeFormApi;
  value: string | null;
}>;

export function LookupSelect(props: LookupSelectProps) {
  const connection = props.form.lookup;
  const connectionId = connection?.connectionRefs[props.lookup.slot];
  if (
    connection === undefined ||
    connectionId === undefined ||
    !connection.scope.enabled
  ) {
    const hint =
      connectionId === undefined
        ? 'Choose a connection first.'
        : 'Options are unavailable for this connection.';
    return (
      <Field>
        <FieldLabel htmlFor={props.id}>{props.field.label}</FieldLabel>
        <ChoiceSelect
          value={props.value}
          choices={
            props.value === null
              ? []
              : [{ value: props.value, label: props.value }]
          }
          disabled
          control={{ id: props.id, describedBy: `${props.id}-lookup` }}
          onChange={() => undefined}
        />
        <FieldDescription id={`${props.id}-lookup`}>{hint}</FieldDescription>
      </Field>
    );
  }
  return (
    <ConnectedLookupSelect
      {...props}
      connectionId={connectionId}
      scope={connection.scope}
    />
  );
}

function ConnectedLookupSelect({
  id,
  field,
  lookup,
  config,
  form,
  value,
  connectionId,
  scope,
}: LookupSelectProps &
  Readonly<{
    connectionId: string;
    scope: NonNullable<NodeFormApi['lookup']>['scope'];
  }>) {
  const query = useQuery(connectionOptions(scope, connectionId, lookup));
  const items = query.data?.items ?? [];
  const selected = items.find((item) => item.value === value);
  const attachTo = lookup.attachTo;
  const stored = attachTo === undefined ? undefined : config[attachTo];
  const drifted =
    selected?.attach !== undefined &&
    (stored === undefined ||
      canonicalJson(stored) !== canonicalJson(selected.attach));
  const hint = lookupHint(query.status, {
    items,
    selected,
    value,
    drifted,
    description: field.description,
  });
  const choices =
    value !== null && selected === undefined
      ? [{ value, label: value }, ...items]
      : items;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <ChoiceSelect
        value={drifted ? null : value}
        choices={choices}
        disabled={!form.editable || query.isError || items.length === 0}
        control={{
          id,
          describedBy: hint === undefined ? undefined : `${id}-lookup`,
        }}
        onChange={(next) => {
          const item = items.find((candidate) => candidate.value === next);
          if (item === undefined) return;
          form.commit((node) => {
            if (node.connectionRefs[lookup.slot] !== connectionId) return {};
            const updated = withFieldValue(node.config, field, item.value);
            if (attachTo === undefined) return { config: updated };
            const { [attachTo]: previous, ...rest } = updated;
            void previous;
            return {
              config:
                item.attach === undefined
                  ? rest
                  : { ...rest, [attachTo]: item.attach },
            };
          }, `${form.nodeId}:config:${field.key}`);
        }}
      />
      {hint === undefined ? null : (
        <FieldDescription id={`${id}-lookup`} role="status">
          {hint}
        </FieldDescription>
      )}
    </Field>
  );
}

function lookupHint(
  status: 'error' | 'pending' | 'success',
  {
    items,
    selected,
    value,
    drifted,
    description,
  }: Readonly<{
    items: ConnectionLookupResponse['items'];
    selected: ConnectionLookupResponse['items'][number] | undefined;
    value: string | null;
    drifted: boolean;
    description: string | undefined;
  }>,
) {
  if (status === 'error') return 'Could not load options.';
  if (status === 'pending') return 'Loading options…';
  if (items.length === 0) return 'No options are available.';
  if (drifted) return 'Review the updated option and select it again.';
  if (value !== null && selected === undefined)
    return 'The saved option is unavailable.';
  return selected?.description ?? description;
}
