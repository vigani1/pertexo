import {
  propertyDefaults,
  AGENT_FIND_ROWS,
  AGENT_STEP_V3,
  AGENT_SEND_SLACK_MESSAGE,
  AGENT_SLACK_CONNECTION_SLOT,
  AGENT_LIMITS,
  AGENT_TOOL_LIMITS,
  isRecord,
  WORKFLOW_CALL,
} from '@pertexo/workflow-model';
import { formatByteSize } from '@pertexo/node-sdk';
import { useState } from 'react';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { Button } from '@/components/ui/button';
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
import {
  agentDraftTools,
  agentTools,
  configuredAgentTool,
  retainedAgentConnections,
  toolFormAt,
} from '../../../model/agent-tool';
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
  agentVersion,
}: Readonly<{
  schema: unknown;
  config: NodeConfig;
  form: NodeFormApi;
  agentVersion: 1 | 2 | 3;
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
      {agentVersion === AGENT_STEP_V3.version ? (
        <AgentToolList schema={schema} config={config} form={form} />
      ) : (
        <AgentToolSetup
          schema={schema}
          config={config}
          form={form}
          agentVersion={agentVersion}
        />
      )}
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

function AgentToolList({
  schema,
  config,
  form,
}: Readonly<{
  schema: unknown;
  config: NodeConfig;
  form: NodeFormApi;
}>) {
  const tools = agentDraftTools(config);
  const listed = tools.length === 0 ? [{}] : tools;
  const [selected, select] = useState(0);
  const index = Math.min(selected, listed.length - 1);
  const replaceTools = (next: readonly NodeConfig[]) => {
    form.commit(
      (node) => ({
        config: withConfigValue(node.config, 'tools', next),
        connectionRefs: retainedAgentConnections(node.connectionRefs, next),
      }),
      'agent-tools',
    );
  };
  return (
    <>
      <div className="flex flex-col gap-2">
        <RuleHeading
          appearance="compact"
          count={`${String(tools.length)} of ${String(AGENT_TOOL_LIMITS.tools)}`}
        >
          Agent tools
        </RuleHeading>
        <ul className="flex flex-wrap gap-2" aria-label="Agent tools">
          {listed.map((tool, indexInList) => {
            const choice = configuredAgentTool(
              { tool },
              agentTools(AGENT_STEP_V3.version),
            );
            const label =
              typeof tool.alias === 'string' && tool.alias !== ''
                ? tool.alias
                : choice.label;
            return (
              <li key={indexInList}>
                <Button
                  type="button"
                  size="sm"
                  variant={indexInList === index ? 'default' : 'outline'}
                  aria-pressed={indexInList === index}
                  onClick={() => {
                    select(indexInList);
                  }}
                >
                  {label}
                </Button>
              </li>
            );
          })}
        </ul>
        {form.editable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={listed.length >= AGENT_TOOL_LIMITS.tools}
              onClick={() => {
                replaceTools([...listed, {}]);
                select(listed.length);
              }}
            >
              Add tool
            </Button>
            {listed.length > 1 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  replaceTools(
                    listed.filter((_, position) => position !== index),
                  );
                  select(Math.max(0, index - 1));
                }}
              >
                Remove tool
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <AgentToolSetup
        key={index}
        schema={schema}
        config={{ ...config, tool: listed[index] ?? {} }}
        form={toolFormAt(form, index)}
        agentVersion={AGENT_STEP_V3.version}
      />
    </>
  );
}

function AgentToolSetup({
  schema,
  config,
  form,
  agentVersion,
}: Readonly<{
  schema: unknown;
  config: NodeConfig;
  form: NodeFormApi;
  agentVersion: 1 | 2 | 3;
}>) {
  const { callScope, definitions } = useInspectorSession();
  const tools = agentTools(agentVersion);
  const selected = configuredAgentTool(config, tools);
  const slack = selected.definition.key === AGENT_SEND_SLACK_MESSAGE.key;
  const callable = selected.definition.key === WORKFLOW_CALL.key;
  const tool = isRecord(config.tool) ? (config.tool as NodeConfig) : {};
  const toolForm = nestedConfigForm(form, 'tool');
  const toolConfig = isRecord(tool.config) ? (tool.config as NodeConfig) : {};
  const targetForm = nestedConfigForm(toolForm, 'config');
  const toolId = fieldControlId(form.nodeId, 'agent-tool');
  const toolSchemas = agentToolSchemas(schema);
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="mb-3 text-sm font-semibold">Tool setup</legend>
      <Field>
        <FieldLabel htmlFor={toolId}>Agent tool</FieldLabel>
        <ChoiceSelect
          value={selected.definition.key}
          choices={tools.map(({ definition, label }) => ({
            value: definition.key,
            label,
          }))}
          disabled={!form.editable}
          onChange={(value) => {
            const next = tools.find(
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
              if (
                next.definition.key !== AGENT_FIND_ROWS.key &&
                isRecord(config) &&
                'tableId' in config
              ) {
                const { tableId: _readBinding, ...nameBinding } = config;
                config = nameBinding;
              }
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
          definition={selected.definition}
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
  if (!isRecord(properties)) return [];
  const many = properties.tools;
  const tool = isRecord(many) ? many.items : properties.tool;
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
