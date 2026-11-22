import {
  AGENT_FIND_ROWS,
  AGENT_LIMITS,
  AGENT_TOOL_LIMITS,
  isRecord,
} from '@pertexo/workflow-model';
import { formatByteSize } from '@pertexo/node-sdk';
import { Disclosure } from '@/components/ui/disclosure';
import { formatCount } from '@/lib/format/count';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { formatTimeSpan } from '@/lib/format/time';
import { schemaFields, type NodeConfig } from '../../../model/inspector/draft';
import { nestedConfigForm } from '../../../model/inspector/nested-config-form';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { SchemaFieldList } from '../fields/schema-list';
import { useInspectorSession } from '../use-session';
import { DataTableSetup } from './table-setup';

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
  const { callScope } = useInspectorSession();
  const properties = isRecord(schema) ? schema.properties : undefined;
  const toolFields = isRecord(properties) ? schemaFields(properties.tool) : [];
  const tool = isRecord(config.tool) ? (config.tool as NodeConfig) : {};
  const toolForm = nestedConfigForm(form, 'tool');
  const toolConfig = isRecord(tool.config) ? (tool.config as NodeConfig) : {};
  const tableForm = nestedConfigForm(toolForm, 'config');
  return (
    <>
      <SchemaFieldList
        fields={schemaFields(schema).filter(
          ({ key, parent }) => key === 'model' && parent === undefined,
        )}
        config={config}
        form={form}
        jsonOnlySettings={false}
      />
      <fieldset className="flex min-w-0 flex-col gap-4 border-l-2 border-border pl-3">
        <legend className="mb-3 text-sm font-semibold">Tool · Find rows</legend>
        <SchemaFieldList
          fields={toolFields.filter(
            ({ key }) => key === 'alias' || key === 'description',
          )}
          config={tool}
          form={toolForm}
          jsonOnlySettings={false}
        />
        <DataTableSetup
          scope={callScope}
          config={toolConfig}
          form={{
            ...tableForm,
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
                    definition: AGENT_FIND_ROWS,
                    config: change.config ?? current,
                  },
                };
              }, key);
            },
          }}
        >
          The model can propose filters and sorting for the selected table.
        </DataTableSetup>
      </fieldset>
      <p className="text-sm text-muted-foreground">
        The mapped task and input, tool schemas and bounded tool results enter
        the model request.
      </p>
      <Disclosure summary="Agent limits">
        <p className="text-sm text-muted-foreground">
          Up to {formatCount(AGENT_LIMITS.turns, 'model turn')},{' '}
          {formatCount(AGENT_LIMITS.toolCalls, 'tool call')}, and{' '}
          {formatCount(AGENT_LIMITS.modelDispatches, 'model request')} including
          retries. The Agent has{' '}
          {formatTimeSpan(AGENT_LIMITS.timeoutMillis / 1000)} to finish.
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
