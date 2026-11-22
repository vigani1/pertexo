import {
  propertyDefaults,
  AGENT_FIND_ROWS,
  AGENT_SEND_SLACK_MESSAGE,
  AGENT_SLACK_CONNECTION_SLOT,
  AGENT_LIMITS,
  AGENT_TOOL_LIMITS,
  isRecord,
  WORKFLOW_CALL,
} from '@pertexo/workflow-model';
import { formatByteSize } from '@pertexo/node-sdk';
import { Disclosure } from '@/components/ui/disclosure';
import { formatCount } from '@/lib/format/count';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { formatTimeSpan } from '@/lib/format/time';
import {
  schemaFields,
  withConfigValue,
  type NodeConfig,
} from '../../../model/inspector/draft';
import { nestedConfigForm } from '../../../model/inspector/nested-config-form';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { SchemaFieldList } from '../fields/schema-list';
import { useInspectorSession } from '../use-session';
import { DataTableSetup } from './table-setup';
import { ChoiceSelect } from '../fields/choice-select';
import { Field, FieldLabel } from '@/components/ui/field';
import { AGENT_TOOLS, configuredAgentTool } from '../../../model/agent-tool';
import { AgentCallableSetup } from './agent-callable-setup';
import { AgentApprovalSetup } from './agent-approval-setup';

const costLimit = new Intl.NumberFormat(FORMAT_LOCALE, {
  style: 'currency',
  currency: 'USD',
}).format(AGENT_LIMITS.costNanoDollars / 1e9);

export function AgentSetup({
  schema,
  config,
  form,
}: Readonly<{
  schema: unknown;
  config: NodeConfig;
  form: NodeFormApi;
}>) {
  const deadline =
    typeof config.timeoutMillis === 'number'
      ? config.timeoutMillis
      : AGENT_LIMITS.timeoutMillis;
  return (
    <>
      <SchemaFieldList
        fields={schemaFields(schema).filter(
          ({ key, parent }) =>
            (key === 'model' || key === 'timeoutMillis') &&
            parent === undefined,
        )}
        config={config}
        form={form}
        jsonOnlySettings={false}
      />
      <AgentToolSetup schema={schema} config={config} form={form} />
      <p className="text-sm text-muted-foreground">
        The mapped task and input, tool schemas and bounded tool results enter
        the model request.
      </p>
      <Disclosure summary="Agent limits">
        <p className="text-sm text-muted-foreground">
          Up to {formatCount(AGENT_LIMITS.turns, 'model turn')},{' '}
          {formatCount(AGENT_LIMITS.toolCalls, 'tool call')}, and{' '}
          {formatCount(AGENT_LIMITS.modelDispatches, 'model request')} including
          retries. The Agent has {formatTimeSpan(deadline / 1000)} to finish.
        </p>
        <p className="text-sm text-muted-foreground">
          Requests allow {formatByteSize(AGENT_TOOL_LIMITS.requestBytes)} and
          tool results allow {formatByteSize(AGENT_TOOL_LIMITS.resultBytes)}.
          Each model turn can return up to{' '}
          {formatCount(AGENT_TOOL_LIMITS.outputTokens, 'output token')}. The
          total budget is {formatCount(AGENT_LIMITS.inputTokens, 'input token')}
          , {formatCount(AGENT_LIMITS.outputTokens, 'output token')}, and{' '}
          {costLimit} in estimated model cost.
        </p>
      </Disclosure>
    </>
  );
}

function AgentToolSetup({
  schema,
  config,
  form,
}: Readonly<{
  schema: unknown;
  config: NodeConfig;
  form: NodeFormApi;
}>) {
  const { callScope, definitions } = useInspectorSession();
  const selected = configuredAgentTool(config);
  const slack = selected.definition.key === AGENT_SEND_SLACK_MESSAGE.key;
  const callable = selected.definition.key === WORKFLOW_CALL.key;
  const tool = isRecord(config.tool) ? (config.tool as NodeConfig) : {};
  const toolForm = nestedConfigForm(form, 'tool');
  const toolConfig = isRecord(tool.config) ? (tool.config as NodeConfig) : {};
  const targetForm = nestedConfigForm(toolForm, 'config');
  const toolId = fieldControlId(form.nodeId, 'agent-tool');
  const toolSchemas = agentToolSchemas(schema);
  return (
    <fieldset className="flex min-w-0 flex-col gap-4 border-l-2 border-border pl-3">
      <legend className="mb-3 text-sm font-semibold">Tool setup</legend>
      <Field>
        <FieldLabel htmlFor={toolId}>Agent tool</FieldLabel>
        <ChoiceSelect
          value={selected.definition.key}
          choices={AGENT_TOOLS.map(({ definition, label }) => ({
            value: definition.key,
            label,
          }))}
          disabled={!form.editable}
          onChange={(value) => {
            const next = AGENT_TOOLS.find(
              ({ definition }) => definition.key === value,
            );
            if (next === undefined || next === selected) return;
            form.commit((node) => {
              const current = isRecord(node.config.tool)
                ? (node.config.tool as NodeConfig)
                : {};
              const { [AGENT_SLACK_CONNECTION_SLOT]: _old, ...connectionRefs } =
                node.connectionRefs;
              const {
                writePermission: _permission,
                config: previous,
                ...identity
              } = current;
              const nextSlack =
                next.definition.key === AGENT_SEND_SLACK_MESSAGE.key;
              let config =
                slack || callable || next.definition.key === WORKFLOW_CALL.key
                  ? {}
                  : previous;
              if (nextSlack)
                config = propertyDefaults(
                  definitions.find(
                    ({ definition }) =>
                      definition.key === AGENT_SEND_SLACK_MESSAGE.key,
                  )?.configSchema,
                );
              return {
                config: withConfigValue(node.config, 'tool', {
                  ...identity,
                  definition: next.definition,
                  ...(config === undefined ? {} : { config }),
                }),
                connectionRefs,
              };
            }, 'agent-tool');
          }}
          control={{ id: toolId }}
        />
      </Field>
      <SchemaFieldList
        fields={schemaFields(toolSchemas[0]).filter(
          ({ key }) => key === 'alias' || key === 'description',
        )}
        config={tool}
        form={toolForm}
        jsonOnlySettings={false}
      />
      {slack ? (
        <SchemaFieldList
          fields={schemaFields(slackToolSetup(toolSchemas))}
          config={toolConfig}
          form={targetForm}
          jsonOnlySettings={false}
        />
      ) : null}
      {callable ? (
        <AgentCallableSetup
          scope={callScope}
          config={toolConfig}
          form={targetForm}
        />
      ) : null}
      {!slack && !callable ? (
        <DataTableSetup
          scope={callScope}
          config={toolConfig}
          form={{
            ...targetForm,
            commit: (update, key) => {
              toolForm.commit((node) => {
                const current = isRecord(node.config.config)
                  ? (node.config.config as NodeConfig)
                  : {};
                const change =
                  typeof update === 'function'
                    ? update({ ...node, config: current })
                    : update;
                return {
                  config: {
                    ...node.config,
                    definition: selected.definition,
                    config: change.config ?? current,
                  },
                };
              }, key);
            },
          }}
        >
          {selected.definition.key === AGENT_FIND_ROWS.key
            ? 'The model can propose filters and sorting for the selected table.'
            : 'The model supplies values for one row in the selected table.'}
        </DataTableSetup>
      ) : null}
      {selected.definition.key === AGENT_FIND_ROWS.key ? null : (
        <AgentApprovalSetup scope={callScope} form={form} tool={tool} />
      )}
    </fieldset>
  );
}

function agentToolSchemas(schema: unknown): readonly unknown[] {
  const properties = isRecord(schema) ? schema.properties : undefined;
  const tool = isRecord(properties) ? properties.tool : undefined;
  return isRecord(tool) && Array.isArray(tool.anyOf)
    ? (tool.anyOf as unknown[])
    : [];
}

function slackToolSetup(shapes: readonly unknown[]) {
  for (const shape of shapes) {
    const props = isRecord(shape) ? shape.properties : undefined;
    const setup = isRecord(props) ? props.config : undefined;
    if (
      isRecord(setup) &&
      isRecord(setup.properties) &&
      'channelId' in setup.properties
    )
      return setup;
  }
  return undefined;
}
