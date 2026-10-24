import { useInspectorSession } from '../../../hooks/use-inspector-session';
import { WaitSetup } from '../wait/setup';
import { UtilitySetup } from '../builders/utility-setup';
import { UTILITY_OPERATION_KEYS } from '../../../model/inspector/transforms/utility-config';
import { httpSetupFields } from '../../../model/inspector/http-pagination/fields';
import { HttpPaginationSetup } from '../http-pagination/setup';
import { DataTableSetup } from '../builders/table-setup';
import { isDataTableDefinition } from '@pertexo/node-sdk';
import { Suspense } from 'react';
import { lazyPiece } from '@/components/patterns/app-update/lazy';
import { SkeletonLines } from '@/components/ui/skeleton';
import { WebhookTriggerSetup } from '../webhook/trigger-setup';
import { WebhookResponseSetup } from '../webhook/response-setup';
import { HumanFormSetup } from '../human-task/setup';
import { CreateFileSetup } from '../builders/create-file-setup';
import { ReadFileSetup } from '../builders/read-file-setup';
import { DateSetup } from '../builders/date-setup';

import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { ReactNode, ComponentType } from 'react';
import type { schemaFields } from '../../../model/inspector/draft';
import { schemaPropertyCount } from '../../../model/inspector/draft';
import {
  readParallelBranches,
  readSwitchCases,
  readValidateRules,
} from '../../../model/inspector/setup-builders';
import type { GraphLevel } from '../../../model/graph/scopes';
import type { ScheduleSchema } from '../../../model/inspector/schedule-draft';
import { ScheduleBuilder } from '../schedule/builder';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { SchemaField } from '../fields/schema-field';
import { ParallelBranches } from '../builders/parallel-branches';
import { SwitchCases } from '../builders/switch-cases';
import { ValidateRules } from '../builders/validate-rules';

const CodeSetup = lazyPiece(() =>
  import('../code/setup').then((module) => module.CodeSetup),
);

export type WorkflowNode = WorkflowGraphContract['nodes'][number];

const SIMPLE_SETUP_RENDERERS: Readonly<
  Record<
    string,
    ComponentType<
      Readonly<{
        definitionKey: string;
        schema: unknown;
        config: WorkflowNode['config'];
        form: NodeFormApi;
      }>
    >
  >
> = {
  'core.wait': WaitSetup,
  'core.respond_webhook': WebhookResponseSetup,
  'core.read_file': ReadFileSetup,
  'core.create_file': CreateFileSetup,
  'core.date': DateSetup,
  ...Object.fromEntries(
    UTILITY_OPERATION_KEYS.map((key) => [key, UtilitySetup]),
  ),
};

/** The controls for a catalog step's setup, when it isn't shown as JSON. */
export function SetupControls({
  node,
  graph,
  configSchema,
  fields,
  scheduleSchema,
  form,
}: Readonly<{
  node: WorkflowNode;
  graph: GraphLevel;
  configSchema: unknown;
  fields: ReturnType<typeof schemaFields>;
  scheduleSchema: ScheduleSchema | undefined;
  form: NodeFormApi;
}>) {
  const { codeSettings, callScope } = useInspectorSession();
  const { config } = node;
  const formKey = node.definition.key;
  const hasCallableForm =
    formKey === 'core.approval' ||
    formKey === 'core.form' ||
    formKey === 'core.request_input';
  if (hasCallableForm)
    return (
      <HumanFormSetup
        definitionKey={formKey}
        node={node}
        graph={graph}
        form={form}
        scope={callScope}
      />
    );
  if (isDataTableDefinition(node.definition))
    return <DataTableSetup scope={callScope} config={config} form={form} />;
  if (node.definition.key === 'core.code')
    return (
      <Suspense fallback={<SkeletonLines label="Loading code editor" />}>
        <CodeSetup config={config} form={form} settings={codeSettings} />
      </Suspense>
    );
  if (node.definition.key === 'core.webhook')
    return <WebhookTriggerSetup node={node} graph={graph} form={form} />;
  const SimpleSetup = SIMPLE_SETUP_RENDERERS[formKey];
  if (SimpleSetup !== undefined)
    return (
      <SimpleSetup
        definitionKey={formKey}
        schema={configSchema}
        config={config}
        form={form}
      />
    );
  if (scheduleSchema !== undefined)
    return (
      <ScheduleBuilder config={config} schema={scheduleSchema} form={form} />
    );
  if (formKey === 'http.request')
    return (
      <>
        <SchemaFieldList
          fields={httpSetupFields(fields, config)}
          config={config}
          form={form}
          jsonOnlySettings={
            schemaPropertyCount(configSchema) > fields.length + 1
          }
        />
        <HttpPaginationSetup
          schema={configSchema}
          config={config}
          form={form}
        />
      </>
    );
  const list = listBuilder(node, graph, form);
  const propertyCount = schemaPropertyCount(configSchema);
  return (
    <>
      {list?.control}
      <SchemaFieldList
        fields={fields}
        config={config}
        form={form}
        jsonOnlySettings={propertyCount > fields.length + (list?.covers ?? 0)}
      />
    </>
  );
}

/**
 * The list a Switch, Parallel or Validate is set up with (cases, branches,
 * rules) as its own builder, when the stored list is one the builder can
 * show without losing anything; otherwise the list stays on JSON.
 */
function listBuilder(
  node: WorkflowNode,
  graph: GraphLevel,
  form: NodeFormApi,
): Readonly<{ control: ReactNode; covers: number }> | undefined {
  const linkedPorts = new Set(
    graph.edges
      .filter((edge) => edge.source.nodeId === node.id)
      .map((edge) => edge.source.port),
  );
  switch (node.definition.key) {
    case 'core.switch': {
      const cases = readSwitchCases(node.config);
      return cases === undefined
        ? undefined
        : {
            control: (
              <SwitchCases
                cases={cases}
                linkedPorts={linkedPorts}
                form={form}
              />
            ),
            covers: 1,
          };
    }
    case 'core.parallel': {
      const branches = readParallelBranches(node.config);
      return branches === undefined
        ? undefined
        : {
            control: (
              <ParallelBranches
                branches={branches}
                linkedPorts={linkedPorts}
                form={form}
              />
            ),
            covers: 1,
          };
    }
    case 'core.validate': {
      const rules = readValidateRules(node.config);
      return rules === undefined
        ? undefined
        : { control: <ValidateRules rules={rules} form={form} />, covers: 1 };
    }
    default:
      return undefined;
  }
}

function SchemaFieldList({
  fields,
  config,
  form,
  jsonOnlySettings,
}: Readonly<{
  fields: ReturnType<typeof schemaFields>;
  config: WorkflowNode['config'];
  form: NodeFormApi;
  /** The schema has properties no field models. */
  jsonOnlySettings: boolean;
}>) {
  return (
    <>
      {fields.map((field) => (
        <SchemaField
          key={field.key}
          field={field}
          config={config}
          form={form}
        />
      ))}
      {jsonOnlySettings ? (
        <p className="text-xs text-subtle-foreground">
          Some settings can only be edited as JSON.
        </p>
      ) : null}
    </>
  );
}
