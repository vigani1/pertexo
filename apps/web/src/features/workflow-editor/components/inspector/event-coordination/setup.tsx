import {
  canonicalJson,
  eventCoordinationPolicySchema,
  type EventCoordinationPolicy,
} from '@pertexo/workflow-model';
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ChoiceSelect } from '../fields/choice-select';
import { MappingValueEditor } from '../input-mappings/value-editor';
import { useInspectorDraftField } from '../use-draft-field';
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import {
  type InputMappingDraftRow,
  validateInputMappingRows,
} from '../../../model/inspector/input-mappings/draft';
import { FORMAT_LOCALE } from '@/lib/format/locale';

export function EventCoordinationSetup({
  node,
  graph,
  form,
}: Readonly<{ node: WorkflowNode; graph: GraphLevel; form: NodeFormApi }>) {
  const result = eventCoordinationPolicySchema.safeParse(
    node.config.coordination,
  );
  const policy = result.success ? result.data : undefined;
  function commit(next: EventCoordinationPolicy | undefined) {
    if (policy?.mode !== next?.mode) {
      form.reportScratch('coordination-key', false);
      for (const name of [
        'Quiet time (seconds)',
        'Window (seconds)',
        'Runs per window',
      ])
        form.reportScratch(
          `${form.nodeId}-coordination-${name.replaceAll(' ', '-')}`,
          false,
        );
    }
    form.commit((current) => {
      const config = { ...current.config };
      if (next === undefined) delete config.coordination;
      else config.coordination = next;
      return { config };
    }, `${node.id}:coordination`);
  }
  const id = `${node.id}-coordination-mode`;
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-3 font-medium">Event coordination</legend>
      <Field>
        <FieldLabel htmlFor={id}>Policy</FieldLabel>
        <ChoiceSelect
          value={policy?.mode ?? 'off'}
          disabled={!form.editable}
          choices={[
            { value: 'off', label: 'Off' },
            { value: 'deduplicate', label: 'Deduplicate' },
            { value: 'debounce', label: 'Debounce' },
            { value: 'throttle', label: 'Throttle' },
          ]}
          onChange={(mode) => {
            const key = policy?.key ?? {
              kind: 'run_input' as const,
              path:
                node.definition.key === 'core.form'
                  ? '$.values.orderId'
                  : '$.orderId',
            };
            switch (mode) {
              case 'off':
                commit(undefined);
                break;
              case 'deduplicate':
                commit({ mode, key, windowSeconds: 86400 });
                break;
              case 'debounce':
                commit({ mode, key, quietSeconds: 5 });
                break;
              case 'throttle':
                commit({
                  mode,
                  key,
                  windowSeconds: 60,
                  limit: 1,
                  onExcess: 'skip',
                });
                break;
              case null:
                break;
            }
          }}
          control={{ id: id }}
        />
        <FieldDescription>
          Group events by a value in their input. Authentication and transport
          retries keep their usual behavior.
        </FieldDescription>
      </Field>
      {node.config.coordination !== undefined && !result.success ? (
        <Notice tone="destructive">
          The saved coordination settings are invalid. Choose a policy to
          replace them.
        </Notice>
      ) : null}
      {policy === undefined ? null : (
        <CoordinationFields
          key={policy.mode}
          policy={policy}
          node={node}
          graph={graph}
          form={form}
          onChange={commit}
        />
      )}
    </fieldset>
  );
}
function CoordinationFields({
  policy,
  node,
  graph,
  form,
  onChange,
}: Readonly<{
  policy: EventCoordinationPolicy;
  node: WorkflowNode;
  graph: GraphLevel;
  form: NodeFormApi;
  onChange: (value: EventCoordinationPolicy) => void;
}>) {
  const draft = useInspectorDraftField<
    EventCoordinationPolicy['key'],
    InputMappingDraftRow
  >({
    value: policy.key,
    format: (value) => ({
      id: 'coordination-key',
      destinationKey: 'key',
      ...value,
    }),
    equals: (a, b) => canonicalJson(a) === canonicalJson(b),
    parse: (row) => {
      const checked = validateInputMappingRows([row], graph, node.id);
      const key = checked.inputMappings?.key;
      if (
        key === undefined ||
        (key.kind !== 'expression' && key.kind !== 'run_input')
      )
        return {
          ok: false,
          error: 'Use a complete event input path or expression.',
        };
      const parsed = eventCoordinationPolicySchema.safeParse({
        ...policy,
        key,
      });
      return parsed.success
        ? { ok: true, value: key }
        : { ok: false, error: 'Use a valid path or a bounded expression.' };
    },
    commit: (key) => {
      onChange({ ...policy, key });
    },
    onScratchChange: (scratch) => {
      form.reportScratch('coordination-key', scratch);
    },
  });
  return (
    <>
      <div onBlurCapture={draft.blur} className="flex min-w-0 flex-col gap-2">
        <p className="text-sm font-medium">Event key</p>
        <MappingValueEditor
          row={draft.text}

          type={undefined}
          error={draft.error}
          disabled={!form.editable}
          allowedKinds={['run_input', 'expression']}
          onChange={draft.change}
          context={{
            nodeId: node.id,
            graph: graph,
            predecessors: [],
            loopPorts: [],
          }}
        />
        <p className="text-xs text-muted-foreground">
          A nonempty text value (up to 512 bytes), number or true/false. Only a
          hash is stored as the key. Expressions read event input only.
        </p>
      </div>
      {policy.mode === 'debounce' ? (
        <NumberSetting
          name="Quiet time (seconds)"
          value={policy.quietSeconds}
          maximum={3600}
          form={form}
          onChange={(quietSeconds) => {
            onChange({ ...policy, quietSeconds });
          }}
        />
      ) : (
        <NumberSetting
          name="Window (seconds)"
          value={policy.windowSeconds}
          maximum={policy.mode === 'deduplicate' ? 604800 : 86400}
          form={form}
          onChange={(windowSeconds) => {
            onChange({ ...policy, windowSeconds });
          }}
        />
      )}
      {policy.mode !== 'throttle' ? null : (
        <>
          <NumberSetting
            name="Runs per window"
            value={policy.limit}
            maximum={1000}
            form={form}
            onChange={(limit) => {
              onChange({ ...policy, limit });
            }}
          />
          <Field>
            <FieldLabel htmlFor={`${node.id}-excess`}>Extra events</FieldLabel>
            <ChoiceSelect
              value={policy.onExcess}
              disabled={!form.editable}
              choices={[
                { value: 'skip', label: 'Skip' },
                { value: 'delay', label: 'Delay in arrival order' },
              ]}
              onChange={(onExcess) => {
                if (onExcess === 'skip' || onExcess === 'delay')
                  onChange({ ...policy, onExcess });
              }}
              control={{ id: `${node.id}-excess` }}
            />
          </Field>
        </>
      )}
      <Notice>
        {POLICY_DESCRIPTION[policy.mode]} Pending events wait at most 24 hours;
        a full run queue may defer admission for up to 15 minutes. Changing the
        published version cancels pending events. Deferred webhooks acknowledge
        with 202 immediately.
      </Notice>
    </>
  );
}
function NumberSetting({
  name,
  value,
  maximum,
  form,
  onChange,
}: Readonly<{
  name: string;
  value: number;
  maximum: number;
  form: NodeFormApi;
  onChange: (value: number) => void;
}>) {
  const id = `${form.nodeId}-coordination-${name.replaceAll(' ', '-')}`;
  const draft = useInspectorDraftField({
    value,
    format: String,
    parse: (text) => {
      const number = Number(text);
      const validDelay =
        text.trim() !== '' &&
        Number.isInteger(number) &&
        number >= 1 &&
        number <= maximum;
      return validDelay
        ? { ok: true, value: number }
        : {
            ok: false,
            error: `Use a whole number from 1 to ${String(maximum)}.`,
          };
    },
    commit: onChange,
    onScratchChange: (scratch) => {
      form.reportScratch(id, scratch);
    },
  });
  return (
    <Field>
      <FieldLabel htmlFor={id}>{name}</FieldLabel>
      <Input
        id={id}
        inputMode="numeric"
        value={draft.text}
        disabled={!form.editable}
        aria-invalid={draft.error !== undefined}
        aria-describedby={draft.error === undefined ? undefined : `${id}-error`}
        onChange={(event) => {
          draft.change(event.currentTarget.value);
        }}
        onBlur={draft.blur}
      />
      {draft.error === undefined ? (
        <FieldDescription>
          1–{maximum.toLocaleString(FORMAT_LOCALE)}
        </FieldDescription>
      ) : (
        <FieldError id={`${id}-error`}>{draft.error}</FieldError>
      )}
    </Field>
  );
}

const POLICY_DESCRIPTION: Readonly<
  Record<EventCoordinationPolicy['mode'], string>
> = {
  deduplicate:
    'Only the first event with this key starts a run within the fixed window. Duplicates do not extend it.',
  debounce:
    'After a quiet period, run with the latest event. Earlier pending inputs are replaced.',
  throttle:
    'A fixed window limits run admissions per key. Delayed events keep their arrival order.',
};
