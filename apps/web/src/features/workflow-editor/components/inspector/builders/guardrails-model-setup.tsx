import {
  GUARDRAILS_LIMITS,
  MODEL_AUTH_TYPE,
  MODEL_ENDPOINT_LOOKUP,
  MODEL_PROVIDER_KEY,
  type GuardrailsModelCheck,
} from '@pertexo/integrations';
import { MODEL_IDENTIFIER_MAX_CHARACTERS } from '@pertexo/node-sdk';
import { useQuery } from '@tanstack/react-query';
import { AssistantDisclosure } from '@/components/patterns/actions/assistant-disclosure';
import { Field, FieldLabel, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { connectionOptions } from '@/features/connections/connections-queries.public';
import { ChoiceSelect } from '../fields/choice-select';
import { ConnectionSlot } from '../fields/connection-slot';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { useInspectorSession } from '../use-session';

const modes = [
  { value: 'injection', label: 'Prompt injection' },
  { value: 'policy', label: 'Text policy' },
];

export function GuardrailsModelSetup({
  check,
  connectionId,
  form,
  onChange,
}: Readonly<{
  check: GuardrailsModelCheck;
  connectionId: string | undefined;
  form: NodeFormApi;
  onChange: (check: GuardrailsModelCheck) => void;
}>) {
  const { connections, connectionLookup } = useInspectorSession();
  const connection = connections.find(({ id }) => id === connectionId);
  const modeId = fieldControlId(form.nodeId, 'guardrails-model-mode');
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 border-l-2 border-border pl-3">
      <legend className="mb-2 text-sm font-semibold">Model review</legend>
      <ConnectionSlot
        requirement={MODEL_AUTH_TYPE}
        selectedId={connectionId}
        connections={connections}
        form={form}
      />
      <LabelledField
        id={fieldControlId(form.nodeId, 'guardrails-model')}
        label="Model identifier"
      >
        {(control) => (
          <Input
            {...control}
            value={check.model}
            disabled={!form.editable}
            maxLength={MODEL_IDENTIFIER_MAX_CHARACTERS}
            onChange={(event) => {
              onChange({ ...check, model: event.target.value });
            }}
          />
        )}
      </LabelledField>
      <Field>
        <FieldLabel htmlFor={modeId}>Review for</FieldLabel>
        <ChoiceSelect
          value={check.mode}
          choices={modes}
          disabled={!form.editable}
          control={{ id: modeId }}
          onChange={(mode) => {
            if (mode === check.mode) return;
            const shared = { kind: 'model', model: check.model } as const;
            if (mode === 'policy') onChange({ ...shared, mode, policy: '' });
            if (mode === 'injection') onChange({ ...shared, mode });
          }}
        />
      </Field>
      {check.mode === 'policy' ? (
        <LabelledField
          id={fieldControlId(form.nodeId, 'guardrails-policy')}
          label="Policy"
        >
          {(control) => (
            <Textarea
              {...control}
              value={check.policy}
              maxLength={GUARDRAILS_LIMITS.policyCharacters}
              rows={3}
              disabled={!form.editable}
              onChange={(event) => {
                onChange({ ...check, policy: event.target.value });
              }}
            />
          )}
        </LabelledField>
      ) : null}
      <GuardrailsTransfer
        scope={connectionLookup}
        connectionId={connectionId}
        connectionName={connection?.name}
        check={check}
      />
    </fieldset>
  );
}

function GuardrailsTransfer({
  scope,
  connectionId,
  connectionName,
  check,
}: Readonly<{
  scope: ReturnType<typeof useInspectorSession>['connectionLookup'];
  connectionId: string | undefined;
  connectionName: string | undefined;
  check: GuardrailsModelCheck;
}>) {
  const endpoint = useQuery({
    ...connectionOptions({
      ...scope,
      connectionId: connectionId ?? '',
      request: {
        providerKey: MODEL_PROVIDER_KEY,
        lookup: MODEL_ENDPOINT_LOOKUP,
      },
    }),
    enabled: scope.enabled && connectionId !== undefined,
  });
  const host = endpoint.data?.items[0]?.attach;
  const content =
    check.mode === 'policy'
      ? 'Sends the mapped text and the policy after the deterministic checks pass.'
      : 'Sends the mapped text after the deterministic checks pass.';
  if (typeof host === 'string' && connectionName !== undefined)
    return (
      <AssistantDisclosure
        inDialog={false}
        destination={{
          connectionName,
          host,
          model: check.model || 'the configured model',
        }}
      >
        {content}
      </AssistantDisclosure>
    );
  return (
    <p className="text-sm text-muted-foreground">
      {content}{' '}
      {connectionId === undefined
        ? 'Choose an AI model connection to see the destination.'
        : 'The destination is unavailable.'}
    </p>
  );
}
