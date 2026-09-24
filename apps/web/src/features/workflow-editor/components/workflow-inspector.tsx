import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import {
  workflowGraphSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { ChevronDownIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useEditorStore } from '../model/editor-store-context';
import { removeWorkflowNode, updateWorkflowNode } from '../model/graph-adapter';
import { persistedNodeState, schemaFields } from '../model/inspector-draft';
import { useNodeConfigurationDraft } from '../model/use-node-configuration-draft';
import {
  directPredecessorOptions,
  inputKeySuggestions,
  inputMappingKeyControlId,
  inputMappingRowsFor,
  inputMappingSourceErrors,
  inputMappingSourceControlId,
  newInputMappingRow,
  nodeUsesRunInputDirectly,
  validateInputMappingRows,
  type InputMappingDraftRow,
  type InputMappingRowErrors,
} from '../model/input-mappings';
import { InputMappingsSection } from './inspector/input-mappings/input-mappings-section';
import { GraphEdgeControls } from './inspector/graph-edge-controls';
import { NodeInspectorHeader } from './inspector/node-inspector-header';
import { SchemaField } from './inspector/schema-field';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export type WorkflowInspectorHandle = Readonly<{
  apply: () => boolean;
  isDirty: () => boolean;
}>;

export function WorkflowInspector({
  definitions,
  connections,
  editable,
  actionRef,
  scratchVersion,
  focusTarget,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  editable: boolean;
  actionRef: Ref<WorkflowInspectorHandle>;
  scratchVersion: number;
  focusTarget?: Readonly<{
    nodeId: string;
    fieldKey?: string;
    mappingKey?: string;
    requestId: number;
  }>;
}>) {
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const node = graph.nodes.find((candidate) => candidate.id === selectedNodeId);
  const definition = definitions.find(
    (candidate) =>
      candidate.definition.key === node?.definition.key &&
      candidate.definition.version === node.definition.version,
  );
  if (node === undefined)
    return (
      <aside
        className="border-l border-white/8 bg-card/65 p-5 backdrop-blur-xl"
        aria-label="Node inspector"
      >
        <h2 className="font-heading text-lg font-semibold">Nothing selected</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Select a node on the canvas to edit its label and configuration.
        </p>
      </aside>
    );
  return (
    <NodeInspectorForm
      key={`${node.id}:${persistedNodeState(node)}:${String(scratchVersion)}`}
      node={node}
      graph={graph}
      definitions={definitions}
      connections={connections}
      editable={editable}
      {...(definition === undefined ? {} : { definition })}
      actionRef={actionRef}
      {...(focusTarget === undefined ? {} : { focusTarget })}
    />
  );
}

function NodeInspectorForm({
  node,
  graph,
  definitions,
  connections,
  editable,
  definition,
  actionRef,
  focusTarget,
}: Readonly<{
  node: WorkflowNode;
  graph: WorkflowGraphContract;
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  editable: boolean;
  definition?: NodeDefinitionCatalogItem;
  actionRef: Ref<WorkflowInspectorHandle>;
  focusTarget?: Readonly<{
    nodeId: string;
    fieldKey?: string;
    mappingKey?: string;
    requestId: number;
  }>;
}>) {
  const transact = useEditorStore((state) => state.transact);
  const selectNode = useEditorStore((state) => state.selectNode);
  const [label, setLabel] = useState(node.label ?? '');
  const [connectionRefs, setConnectionRefs] = useState(node.connectionRefs);
  const fields = useMemo(
    () => schemaFields(definition?.configSchema),
    [definition?.configSchema],
  );
  const configuration = useNodeConfigurationDraft(node.config, fields);
  const [advancedOpen, setAdvancedOpen] = useState(
    definition === undefined || fields.length === 0,
  );
  const mappingSectionEnabled = !nodeUsesRunInputDirectly(node.definition);
  const initialMappingRows = useMemo(
    () => inputMappingRowsFor(node.inputMappings),
    [node.inputMappings],
  );
  const [mappingRows, setMappingRows] = useState(initialMappingRows);
  const [mappingErrors, setMappingErrors] = useState<
    Readonly<Record<string, InputMappingRowErrors>>
  >({});
  const [mappingSectionError, setMappingSectionError] = useState<string>();
  const mappingRowSequence = useRef(initialMappingRows.length);
  const liveMappingErrors = inputMappingSourceErrors(
    mappingRows,
    graph,
    node.id,
  );
  const displayedMappingErrors = mergeMappingErrors(
    liveMappingErrors,
    mappingErrors,
  );
  const dirty =
    label !== (node.label ?? '') ||
    JSON.stringify(connectionRefs) !== JSON.stringify(node.connectionRefs) ||
    configuration.dirty ||
    (mappingSectionEnabled &&
      JSON.stringify(mappingRows) !== JSON.stringify(initialMappingRows));

  useEffect(() => {
    if (focusTarget?.nodeId !== node.id) return;
    const mappingRow =
      focusTarget.mappingKey === undefined
        ? undefined
        : initialMappingRows.find(
            (row) => row.destinationKey === focusTarget.mappingKey,
          );
    const targetId =
      mappingRow !== undefined
        ? inputMappingKeyControlId(node.id, mappingRow.id)
        : focusTarget.fieldKey === undefined
          ? `node-label-${node.id}`
          : `config-${node.id}-${focusTarget.fieldKey}`;
    document.getElementById(targetId)?.focus();
  }, [focusTarget, initialMappingRows, node.id]);

  const apply = useCallback(() => {
    const validated = configuration.validate();
    if (validated.kind === 'json') {
      setAdvancedOpen(true);
      return false;
    }
    if (validated.kind === 'field') {
      if (validated.firstInvalidKey !== undefined)
        document
          .getElementById(`config-${node.id}-${validated.firstInvalidKey}`)
          ?.focus();
      return false;
    }
    const mappings = mappingSectionEnabled
      ? validateInputMappingRows(mappingRows, graph, node.id)
      : { inputMappings: node.inputMappings, errors: {} };
    if (mappings.inputMappings === undefined) {
      setMappingErrors(mappings.errors);
      setMappingSectionError('Correct the input mappings before applying.');
      focusFirstMappingError(node.id, mappingRows, mappings.errors, graph);
      return false;
    }
    const nextGraph = updateWorkflowNode(graph, node.id, {
      label: label.trim() === '' ? undefined : label.trim(),
      config: validated.config,
      inputMappings: mappings.inputMappings,
      connectionRefs,
    });
    if (!workflowGraphSchema.safeParse(nextGraph).success) {
      setMappingSectionError(
        'The updated node does not satisfy the workflow graph contract.',
      );
      return false;
    }
    transact(nextGraph);
    configuration.clearErrors();
    setMappingErrors({});
    setMappingSectionError(undefined);
    return true;
  }, [
    configuration,
    connectionRefs,
    graph,
    label,
    mappingRows,
    mappingSectionEnabled,
    node.inputMappings,
    node.id,
    transact,
  ]);

  useImperativeHandle(actionRef, () => ({ apply, isDirty: () => dirty }), [
    apply,
    dirty,
  ]);

  function updateMappingRows(rows: readonly InputMappingDraftRow[]) {
    setMappingRows(rows);
    setMappingSectionError(undefined);
    if (Object.keys(mappingErrors).length === 0) return;
    setMappingErrors(validateInputMappingRows(rows, graph, node.id).errors);
  }

  return (
    <aside
      className="flex min-h-0 flex-col border-l border-white/8 bg-card/65 backdrop-blur-xl"
      aria-label="Node inspector"
    >
      <NodeInspectorHeader
        label={node.label ?? node.definition.key}
        definitionIdentity={`${node.definition.key}@${String(node.definition.version)}`}
        family={definition?.family ?? 'unknown'}
        supported={definition !== undefined}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`node-label-${node.id}`}>Label</FieldLabel>
            <Input
              id={`node-label-${node.id}`}
              name="nodeLabel"
              autoComplete="off"
              value={label}
              disabled={!editable}
              onChange={(event) => {
                setLabel(event.currentTarget.value);
              }}
            />
          </Field>
          {fields.map((field) => (
            <SchemaField
              key={field.key}
              field={field}
              value={
                configuration.ordinaryScratchOwners.has(field.key)
                  ? configuration.ordinaryScratch[field.key]
                  : configuration.config[field.key]
              }
              nodeId={node.id}
              {...(field.kind === 'number' || field.kind === 'integer'
                ? {
                    scratchValue: configuration.numericScratch[field.key] ?? '',
                  }
                : {})}
              {...(configuration.fieldErrors[field.key] === undefined
                ? {}
                : { error: configuration.fieldErrors[field.key] })}
              disabled={!editable}
              onChange={(value) => {
                configuration.updateField(field.key, value);
              }}
              onScratchChange={(value) => {
                configuration.updateNumber(field, value);
              }}
            />
          ))}
          {(definition?.connectionRequirements ?? []).map((requirement) => {
            const matchingConnections = connections.filter(
              (connection) =>
                connection.authType === requirement &&
                connection.status === 'active',
            );
            return (
              <Field key={requirement}>
                <FieldLabel htmlFor={`connection-${node.id}-${requirement}`}>
                  {connectionRequirementLabel(requirement)}
                </FieldLabel>
                <select
                  id={`connection-${node.id}-${requirement}`}
                  name={`connection.${requirement}`}
                  autoComplete="off"
                  className="recessed-control h-10 rounded-lg border px-3 text-base"
                  value={connectionRefs[requirement] ?? ''}
                  disabled={!editable}
                  onChange={(event) => {
                    const connectionId = event.currentTarget.value;
                    setConnectionRefs((current) =>
                      connectionId === ''
                        ? Object.fromEntries(
                            Object.entries(current).filter(
                              ([key]) => key !== requirement,
                            ),
                          )
                        : { ...current, [requirement]: connectionId },
                    );
                  }}
                >
                  <option value="">Choose a connection</option>
                  {matchingConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </select>
                {matchingConnections.length === 0 ? (
                  <FieldDescription>
                    No active matching connection is available in this
                    workspace.
                  </FieldDescription>
                ) : null}
              </Field>
            );
          })}
          <details
            open={advancedOpen}
            onToggle={(event) => {
              setAdvancedOpen(event.currentTarget.open);
            }}
            className="rounded-lg border border-white/8 bg-black/10"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 text-sm font-medium hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              Advanced configuration
              <ChevronDownIcon
                aria-hidden="true"
                className={advancedOpen ? 'rotate-180' : undefined}
              />
            </summary>
            <div className="border-t border-white/8 p-3">
              <Field data-invalid={configuration.error !== undefined}>
                <FieldLabel htmlFor={`node-config-${node.id}`}>
                  Configuration
                </FieldLabel>
                <Textarea
                  id={`node-config-${node.id}`}
                  name="nodeConfiguration"
                  autoComplete="off"
                  className="min-h-64 font-mono text-base"
                  value={configuration.json}
                  disabled={!editable}
                  aria-invalid={configuration.error !== undefined}
                  onChange={(event) => {
                    configuration.updateJson(event.currentTarget.value);
                  }}
                />
                <FieldDescription>
                  {definition === undefined
                    ? 'This definition is not in the current catalog. Its complete configuration is preserved.'
                    : 'JSON Schema fields are preserved exactly. Use JSON for properties without a structured control.'}
                </FieldDescription>
                {configuration.error === undefined ? null : (
                  <FieldError>{configuration.error}</FieldError>
                )}
              </Field>
            </div>
          </details>
          {mappingSectionEnabled ? (
            <InputMappingsSection
              nodeId={node.id}
              rows={mappingRows}
              suggestions={inputKeySuggestions(definition?.inputSchema)}
              predecessors={directPredecessorOptions(graph, node.id)}
              errors={displayedMappingErrors}
              {...(mappingSectionError === undefined
                ? {}
                : { sectionError: mappingSectionError })}
              editable={editable && definition !== undefined}
              onRowsChange={updateMappingRows}
              onAdd={() => {
                const row = newInputMappingRow(
                  `new-${String(mappingRowSequence.current)}`,
                );
                mappingRowSequence.current += 1;
                updateMappingRows([...mappingRows, row]);
              }}
            />
          ) : (
            <p className="rounded-lg border border-white/8 bg-card/35 p-3 text-sm text-muted-foreground">
              This trigger receives the accepted run input directly. Input
              mappings do not change its execution input.
            </p>
          )}
          {editable && graph.nodes.length > 1 ? (
            <GraphEdgeControls
              node={node}
              graph={graph}
              definitions={definitions}
              {...(definition === undefined ? {} : { definition })}
            />
          ) : null}
          {editable ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!dirty} onClick={apply}>
                Apply changes
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!dirty}
                onClick={() => {
                  setLabel(node.label ?? '');
                  setConnectionRefs(node.connectionRefs);
                  setMappingRows(initialMappingRows);
                  configuration.discard();
                  setMappingErrors({});
                  setMappingSectionError(undefined);
                }}
              >
                Cancel changes
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  transact(removeWorkflowNode(graph, node.id));
                  selectNode(null);
                }}
              >
                Delete node
              </Button>
            </div>
          ) : null}
        </FieldGroup>
      </div>
    </aside>
  );
}

function connectionRequirementLabel(requirement: string): string {
  return `${requirement.replaceAll('_', ' ')} connection`;
}

function focusFirstMappingError(
  nodeId: string,
  rows: readonly InputMappingDraftRow[],
  errors: Readonly<Record<string, InputMappingRowErrors>>,
  graph: WorkflowGraphContract,
): void {
  const row = rows.find((candidate) => errors[candidate.id] !== undefined);
  if (row === undefined) return;
  const rowErrors = errors[row.id];
  const targetId =
    rowErrors?.destinationKey !== undefined
      ? inputMappingKeyControlId(nodeId, row.id)
      : row.kind === 'node_output' &&
          !directPredecessorOptions(graph, nodeId).some(
            ({ nodeId: predecessorId }) => predecessorId === row.nodeId,
          )
        ? `${inputMappingSourceControlId(nodeId, row.id)}-node`
        : inputMappingSourceControlId(nodeId, row.id);
  document.getElementById(targetId)?.focus();
}

function mergeMappingErrors(
  sourceErrors: Readonly<Record<string, InputMappingRowErrors>>,
  submittedErrors: Readonly<Record<string, InputMappingRowErrors>>,
): Readonly<Record<string, InputMappingRowErrors>> {
  const rowIds = new Set([
    ...Object.keys(sourceErrors),
    ...Object.keys(submittedErrors),
  ]);
  return Object.fromEntries(
    [...rowIds].map((rowId) => [
      rowId,
      { ...sourceErrors[rowId], ...submittedErrors[rowId] },
    ]),
  );
}
