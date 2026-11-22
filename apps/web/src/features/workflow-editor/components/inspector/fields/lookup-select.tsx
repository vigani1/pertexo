import { useQuery } from '@tanstack/react-query';
import type { ConnectionLookupField } from '@pertexo/contracts';
import { canonicalJson } from '@pertexo/workflow-model';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  withFieldValue,
  type NodeConfig,
  type SchemaFieldSpec,
} from '../../../model/inspector/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { connectionOptions } from '../../../data/connection-options.queries';
import { useInspectorSession } from '../use-session';
import { ChoiceSelect } from './choice-select';

export function LookupSelect({
  id,
  field,
  lookup,
  config,
  form,
  value,
}: Readonly<{
  id: string;
  field: SchemaFieldSpec;
  lookup: ConnectionLookupField;
  config: NodeConfig;
  form: NodeFormApi;
  value: string | null;
}>) {
  const { channelLookup: scope } = useInspectorSession();
  const connectionId = form.connectionRefs?.[lookup.slot];
  const query = useQuery(
    connectionOptions(scope, scope.enabled ? connectionId : undefined, lookup),
  );
  const items = query.data?.items ?? [];
  const selected = items.find((item) => item.value === value);
  const attachTo = lookup.attachTo;
  const stored = attachTo === undefined ? undefined : config[attachTo];
  const drifted =
    selected !== undefined &&
    selected.attach !== undefined &&
    (stored === undefined ||
      canonicalJson(stored) !== canonicalJson(selected.attach));
  const hint =
    connectionId === undefined
      ? 'Choose a connection first.'
      : !scope.enabled
        ? 'Options are unavailable for this connection.'
        : query.isError
          ? 'Could not load options.'
          : query.isPending
            ? 'Loading options…'
            : items.length === 0
              ? 'No options are available.'
              : drifted
                ? 'Review the updated option and select it again.'
                : value !== null && selected === undefined
                  ? 'The saved option is unavailable.'
                  : (selected?.description ?? field.description);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <ChoiceSelect
        value={drifted ? null : value}
        choices={
          value !== null && selected === undefined
            ? [{ value, label: value }, ...items]
            : items
        }
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
