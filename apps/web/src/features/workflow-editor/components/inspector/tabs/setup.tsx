import { WaitSetup } from '../wait/setup';
import { RunValuesSetup } from '../run-values/setup';
import { UtilitySetup } from '../builders/utility-setup';
import { UTILITY_OPERATION_KEYS } from '../../../model/inspector/transforms/utility-config';
import { useScratchForm } from '../use-draft-field';
import { httpSetupFields } from '../../../model/inspector/http-pagination/fields';
import { HttpPaginationSetup } from '../http-pagination/setup';
import { StepRetrySetup } from '../retries/setup';
import { DataTableSetup } from '../builders/table-setup';
import { isDataTableDefinition, type CodeSettings } from '@pertexo/node-sdk';
import { Suspense } from 'react';
import { lazyPiece } from '@/components/patterns/app-update/lazy';
import { SkeletonLines } from '@/components/ui/skeleton';
import { WebhookTriggerSetup } from '../webhook/trigger-setup';
import { WebhookResponseSetup } from '../webhook/response-setup';
import { HumanFormSetup } from '../human-task/setup';
import { CreateFileSetup } from '../builders/create-file-setup';
import { ReadFileSetup } from '../builders/read-file-setup';
import { DateSetup } from '../builders/date-setup';
import { CallTargetField } from '../fields/call-target';
import type { CallTargetScope } from '../../../data/call-targets.queries';
import type {
  NodeDefinitionCatalogItem,
  ConnectionResponse,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { BracesIcon, ListIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode, type ComponentType } from 'react';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import {
  schemaFields,
  schemaPropertyCount,
} from '../../../model/inspector/draft';
import { describeTransformFields } from '../../../model/inspector/transforms/fields';
import { stepTitle } from '../../../model/graph/adapter';
import {
  readParallelBranches,
  readSwitchCases,
  readValidateRules,
} from '../../../model/inspector/setup-builders';
import type { GraphLevel } from '../../../model/graph/scopes';
import {
  readScheduleSchema,
  type ScheduleSchema,
} from '../../../model/inspector/schedule-draft';
import { ConfigJsonEditor } from '../fields/config-json-editor';
import { ConnectionSlot } from '../fields/connection-slot';
import { ScheduleBuilder } from '../schedule/builder';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { SchemaField } from '../fields/schema-field';
import { ParallelBranches } from '../builders/parallel-branches';
import { SwitchCases } from '../builders/switch-cases';
import { ValidateRules } from '../builders/validate-rules';

const CodeSetup = lazyPiece(() =>
  import('../code/setup').then((module) => module.CodeSetup),
);

type WorkflowNode = WorkflowGraphContract['nodes'][number];

const SCHEDULE_KEY = 'core.schedule';

/**
 * Setup: schema-driven controls (a rule builder for the Schedule step),
 * connection slots and "Edit as JSON" for everything the controls don't
 * model. Nothing a schema allows is dropped.
 */
type SetupTabProps = Readonly<{
  definitions?: readonly NodeDefinitionCatalogItem[];
  codeSettings?: CodeSettings | undefined;
  node: WorkflowNode;
  definition: NodeDefinitionCatalogItem | undefined;
  connections: readonly ConnectionResponse[];
  form: NodeFormApi;
  /** The steps around this one and their links. */
  graph: GraphLevel;
  /** Shows the Inputs tab, where a step with no setup is decided. */
  onOpenInputs: () => void;
  callScope?: CallTargetScope;
}>;

export function SetupTab(props: SetupTabProps) {
  return (
    <>
      {props.node.definition.key === 'core.run_values' ? (
        <RunValuesSetup
          node={props.node}
          graph={props.graph}
          definitions={props.definitions ?? []}
          form={props.form}
          variableScope={props.callScope}
        />
      ) : props.node.definition.key === 'core.call' &&
        props.callScope !== undefined ? (
        <FieldGroup className="gap-4">
          <CallTargetField
            node={props.node}
            form={props.form}
            scope={props.callScope}
          />
        </FieldGroup>
      ) : (
        <CatalogSetupTab {...props} />
      )}
      <StepRetrySetup node={props.node} form={props.form} />
    </>
  );
}

function CatalogSetupTab({
  definitions = [],
  codeSettings,
  node,
  definition,
  connections,
  form,
  graph,
  onOpenInputs,
  callScope,
}: SetupTabProps) {
  const fields = useMemo(
    () =>
      withStepChoices(
        describeTransformFields(
          schemaFields(definition?.configSchema),
          node.definition.key,
        ),
        node,
        graph,
      ),
    [definition?.configSchema, node, graph],
  );
  const scheduleSchema = useMemo(
    () =>
      node.definition.key === SCHEDULE_KEY
        ? readScheduleSchema(definition?.configSchema)
        : undefined,
    [node.definition.key, definition?.configSchema],
  );
  const [jsonMode, setJsonMode] = useState(false);
  const { form: setupForm, hasScratch: setupScratch } = useScratchForm(form);
  const onlyJson = definition === undefined;
  const showJson = onlyJson || jsonMode;
  // A step whose schema has nothing to set (Condition, say) is decided by
  // its inputs: point there instead of offering an empty JSON object.
  const nothingToSet =
    !onlyJson &&
    scheduleSchema === undefined &&
    fields.length === 0 &&
    Object.keys(node.config).length === 0 &&
    schemaPropertyCount(definition.configSchema) === 0;
  return (
    <FieldGroup className="gap-4">
      {(definition?.connectionRequirements ?? []).map((requirement) => (
        <ConnectionSlot
          key={requirement}
          requirement={requirement}
          optional={
            definition?.optionalConnections?.includes(requirement) ?? false
          }
          selectedId={node.connectionRefs[requirement]}
          connections={connections}
          form={form}
        />
      ))}
      {nothingToSet ? (
        <div className="flex flex-col items-start gap-1.5 text-sm text-muted-foreground">
          <p>
            Nothing to set up here. What this step does comes from its inputs.
          </p>
          <Button type="button" variant="link" onClick={onOpenInputs}>
            Go to Inputs
          </Button>
        </div>
      ) : showJson ? (
        <ConfigJsonEditor
          config={node.config}
          form={setupForm}
          description={
            onlyJson
              ? 'This step type isn’t in the catalog, so its setup is kept exactly as it is.'
              : 'Every property is kept, including ones the fields above don’t show.'
          }
        />
      ) : (
        <SetupControls
          definitions={definitions}
          codeSettings={codeSettings}
          {...(callScope === undefined ? {} : { callScope })}
          node={node}
          graph={graph}
          configSchema={definition.configSchema}
          fields={fields}
          scheduleSchema={scheduleSchema}
          form={setupForm}
        />
      )}
      {onlyJson || nothingToSet ? null : (
        <JsonModeToggle
          jsonMode={jsonMode}
          disabled={setupScratch}
          onToggle={() => {
            setJsonMode((current) => !current);
          }}
        />
      )}
    </FieldGroup>
  );
}

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
function SetupControls({
  definitions,
  codeSettings,
  node,
  graph,
  configSchema,
  fields,
  scheduleSchema,
  form,
  callScope,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  codeSettings?: CodeSettings | undefined;
  node: WorkflowNode;
  graph: GraphLevel;
  callScope?: CallTargetScope;
  configSchema: unknown;
  fields: ReturnType<typeof schemaFields>;
  scheduleSchema: ScheduleSchema | undefined;
  form: NodeFormApi;
}>) {
  const { config } = node;
  const formKey = node.definition.key;
  const hasCallableForm =
    (formKey === 'core.approval' ||
      formKey === 'core.form' ||
      formKey === 'core.request_input') &&
    callScope !== undefined;
  if (hasCallableForm)
    return (
      <HumanFormSetup
        definitions={definitions}
        definitionKey={formKey}
        node={node}
        graph={graph}
        form={form}
        scope={callScope}
      />
    );
  if (isDataTableDefinition(node.definition) && callScope !== undefined)
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

function JsonModeToggle({
  jsonMode,
  disabled,
  onToggle,
}: Readonly<{ jsonMode: boolean; disabled: boolean; onToggle: () => void }>) {
  const Icon = jsonMode ? ListIcon : BracesIcon;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="w-fit"
      disabled={disabled}
      onClick={onToggle}
    >
      <Icon data-icon="inline-start" />
      {jsonMode ? 'Back to fields' : 'Edit as JSON'}
    </Button>
  );
}

/**
 * Fields that depend on the steps around this one: a Merge names the
 * Parallel it joins by that step's ID, so the Parallel steps are offered by
 * name; a Parallel runs at most as many branches at once as it has.
 */
function withStepChoices(
  fields: ReturnType<typeof schemaFields>,
  node: WorkflowNode,
  graph: Pick<GraphLevel, 'nodes'>,
): ReturnType<typeof schemaFields> {
  if (node.definition.key === 'core.parallel') {
    const branches = readParallelBranches(node.config)?.length;
    return fields.map((field) =>
      field.key === 'maxConcurrency'
        ? {
            ...field,
            ...(branches === undefined || branches === 0
              ? {}
              : { maximum: branches }),
            description:
              'How many branches run at the same time; the rest wait their turn.',
          }
        : field,
    );
  }
  if (node.definition.key !== 'core.merge') return fields;
  const parallels = graph.nodes.filter(
    (candidate) => candidate.definition.key === 'core.parallel',
  );
  return fields.map((field) =>
    field.key === 'parallelNodeId'
      ? {
          ...field,
          options: parallels.map((parallel) => parallel.id),
          optionLabels: Object.fromEntries(
            parallels.map((parallel) => [parallel.id, stepTitle(parallel)]),
          ),
          description:
            parallels.length === 0
              ? 'Add a Parallel step first; a Merge joins its branches.'
              : 'The Parallel step whose branches this step waits for.',
        }
      : field,
  );
}
