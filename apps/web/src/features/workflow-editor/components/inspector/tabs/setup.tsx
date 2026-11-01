import { useInspectorSession } from '../use-session';
import { RunValuesSetup } from '../run-values/setup';
import { useScratchForm } from '../use-draft-field';
import { StepRetrySetup } from '../retries/setup';

import { CallTargetField } from '../fields/call-target';
import { ConditionSetup } from '../condition/setup';

import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { BracesIcon, ListIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import {
  schemaFields,
  schemaPropertyCount,
} from '../../../model/inspector/draft';
import { describeTransformFields } from '../../../model/inspector/transforms/fields';
import { stepTitle } from '../../../model/graph/adapter';
import { readParallelBranches } from '../../../model/inspector/setup-builders';
import type { GraphLevel } from '../../../model/graph/scopes';
import { readScheduleSchema } from '../../../model/inspector/schedule-draft';
import { ConfigJsonEditor } from '../fields/config-json-editor';
import { ConnectionSlot } from '../fields/connection-slot';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import type { WorkflowNode } from './setup-controls';
import { SetupControls } from './setup-controls';

const SCHEDULE_KEY = 'core.schedule';

/**
 * Setup: schema-driven controls (a rule builder for the Schedule step),
 * connection slots and "Edit as JSON" for everything the controls don't
 * model. Nothing a schema allows is dropped.
 */
type SetupTabProps = Readonly<{
  node: WorkflowNode;
  definition: NodeDefinitionCatalogItem | undefined;
  form: NodeFormApi;
  /** The steps around this one and their links. */
  graph: GraphLevel;
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  /** Shows the Inputs tab, where a step with no setup is decided. */
  onOpenInputs: () => void;
}>;

export function SetupTab(props: SetupTabProps) {
  return (
    <>
      <PrimarySetup {...props} />
      <StepRetrySetup node={props.node} form={props.form} />
    </>
  );
}

function CatalogSetupTab({
  node,
  definition,
  form,
  graph,
  loopPorts,
  onOpenInputs,
}: SetupTabProps) {
  const { connections } = useInspectorSession();
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
      <CatalogFields
        context={{
          node,
          definition,
          form: setupForm,
          graph,
          loopPorts,
          onOpenInputs,
        }}
        fields={fields}
        scheduleSchema={scheduleSchema}
        mode={{ nothingToSet, showJson }}
      />
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

function PrimarySetup(props: SetupTabProps) {
  const { definitions, callScope } = useInspectorSession();
  if (props.node.definition.key === 'core.run_values')
    return (
      <RunValuesSetup
        definitions={definitions}
        node={props.node}
        graph={props.graph}
        form={props.form}
        variableScope={callScope}
      />
    );
  if (props.node.definition.key === 'core.condition')
    return (
      <ConditionSetup
        node={props.node}
        graph={props.graph}
        loopPorts={props.loopPorts}
        form={props.form}
        onOpenInputs={props.onOpenInputs}
      />
    );
  if (props.node.definition.key === 'core.call')
    return (
      <FieldGroup className="gap-4">
        <CallTargetField
          node={props.node}
          form={props.form}
          scope={callScope}
        />
      </FieldGroup>
    );
  return <CatalogSetupTab {...props} />;
}

function CatalogFields({
  context,
  fields,
  scheduleSchema,
  mode,
}: Readonly<{
  context: SetupTabProps;
  fields: ReturnType<typeof schemaFields>;
  scheduleSchema: ReturnType<typeof readScheduleSchema>;
  mode: Readonly<{ nothingToSet: boolean; showJson: boolean }>;
}>) {
  const { node, definition, form, graph, onOpenInputs } = context;
  if (mode.nothingToSet)
    return (
      <div className="flex flex-col items-start gap-1.5 text-sm text-muted-foreground">
        <p>
          Nothing to set up here. What this step does comes from its inputs.
        </p>
        <Button type="button" variant="link" onClick={onOpenInputs}>
          Go to Inputs
        </Button>
      </div>
    );
  if (definition === undefined || mode.showJson)
    return (
      <ConfigJsonEditor
        config={node.config}
        form={form}
        description={
          definition === undefined
            ? 'This step type isn’t in the catalog, so its setup is kept exactly as it is.'
            : 'Every property is kept, including ones the fields above don’t show.'
        }
      />
    );
  return (
    <SetupControls
      node={node}
      graph={graph}
      configSchema={definition.configSchema}
      fields={fields}
      scheduleSchema={scheduleSchema}
      form={form}
    />
  );
}
