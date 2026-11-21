import { useInspectorSession } from '../use-session';
import { WaitSetup } from '../wait/setup';
import {
  httpAdvancedInUse,
  httpSetupFields,
  splitHttpSetupFields,
} from '../../../model/inspector/http-pagination/fields';
import { Disclosure } from '@/components/ui/disclosure';
import { HttpPaginationSetup } from '../http-pagination/setup';
import { DataTableSetup } from '../builders/table-setup';
import { isDataTableDefinition } from '@pertexo/node-sdk';
import { Suspense } from 'react';
import { lazyPiece } from '@/components/patterns/app-update/lazy';
import { SkeletonLines } from '@/components/ui/skeleton';
import { WebhookTriggerSetup } from '../webhook/trigger-setup';
import { WebhookResponseSetup } from '../webhook/response-setup';
import { HumanFormSetup } from '../human-task/setup';
import { CreateFileSetup } from '../builders/files/create-setup';
import { ReadFileSetup } from '../builders/files/read-setup';

import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { ReactNode, ComponentType } from 'react';
import {
  coveredProperties,
  schemaPropertyCount,
  type SchemaFieldSpec,
} from '../../../model/inspector/draft';
import { readSchemaUnion } from '../../../model/inspector/schema-union';
import {
  readParallelBranches,
  readSwitchCases,
  readValidateRules,
} from '../../../model/inspector/setup-builders';
import type { GraphLevel } from '../../../model/graph/scopes';
import type { ScheduleSchema } from '../../../model/inspector/schedule-draft';
import { ScheduleBuilder } from '../schedule/builder';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { SchemaFieldList } from '../fields/schema-list';
import { SchemaUnionSetup } from '../fields/union-setup';
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
  fields: readonly SchemaFieldSpec[];
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
  const union = readSchemaUnion(configSchema);
  if (union !== undefined)
    return <SchemaUnionSetup union={union} config={config} form={form} />;
  if (formKey === 'http.request') {
    const { essential, advanced } = splitHttpSetupFields(
      httpSetupFields(fields, config),
    );
    return (
      <>
        <SchemaFieldList
          fields={essential}
          config={config}
          form={form}
          jsonOnlySettings={
            schemaPropertyCount(configSchema) > coveredProperties(fields) + 1
          }
        />
        <Disclosure
          summary="Advanced: limits, error responses and paging"
          defaultOpen={httpAdvancedInUse(config)}
          appearance={{ tone: 'strong' }}
          className="border-t border-border pt-3"
          contentClassName="flex flex-col gap-4"
        >
          <SchemaFieldList
            fields={advanced}
            config={config}
            form={form}
            jsonOnlySettings={false}
          />
          <HttpPaginationSetup
            schema={configSchema}
            config={config}
            form={form}
          />
        </Disclosure>
      </>
    );
  }
  const list = listBuilder(node, graph, form);
  const propertyCount = schemaPropertyCount(configSchema);
  return (
    <>
      {list?.control}
      <SchemaFieldList
        fields={fields}
        config={config}
        form={form}
        jsonOnlySettings={
          propertyCount > coveredProperties(fields) + (list?.covers ?? 0)
        }
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
