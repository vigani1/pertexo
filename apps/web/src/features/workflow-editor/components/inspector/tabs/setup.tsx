import { RunValuesSetup } from '../run-values/setup';
import { useScratchForm } from '../use-draft-field';
import { StepRetrySetup } from '../retries/setup';
import type { CodeSettings } from '@pertexo/node-sdk';
import { CallTargetField } from '../fields/call-target';
import type { CallTargetScope } from '../../../data/call-targets.queries';
import type {
  NodeDefinitionCatalogItem,
  ConnectionResponse,
} from '@pertexo/contracts';
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
