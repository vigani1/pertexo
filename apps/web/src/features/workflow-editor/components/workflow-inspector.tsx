import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import {
  workflowGraphSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts/schemas/workflow-authoring';
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
import {
  removeWorkflowNode,
  connectWorkflowNodes,
  updateWorkflowNode,
} from '../model/graph-adapter';
import {
  isJsonObject,
  applyOrdinaryFieldScratch,
  applyNumericScratch,
  numericScratchFor,
  ordinaryFieldScratchFor,
  parseJson,
  persistedNodeState,
  schemaFields,
  type NodeConfig,
  type SchemaFieldSpec,
} from '../model/inspector-draft';
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
import { NodeInspectorHeader } from './inspector/node-inspector-header';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export type WorkflowInspectorHandle = Readonly<{
  apply: () => boolean;
}>;

export function WorkflowInspector({
  definitions,
  connections,
  editable,
  onFormDirtyChange,
  actionRef,
  scratchVersion,
  focusTarget,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  editable: boolean;
  onFormDirtyChange: (dirty: boolean) => void;
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
        <p className="font-mono text-[0.64rem] tracking-[0.14em] text-primary/75 uppercase">
          Inspector
        </p>
        <h2 className="mt-2 font-heading text-lg font-semibold">
          Nothing selected
        </h2>
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
      onFormDirtyChange={onFormDirtyChange}
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
  onFormDirtyChange,
  actionRef,
  focusTarget,
}: Readonly<{
  node: WorkflowNode;
  graph: WorkflowGraphContract;
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  editable: boolean;
  definition?: NodeDefinitionCatalogItem;
  onFormDirtyChange: (dirty: boolean) => void;
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
  const [json, setJson] = useState(() => JSON.stringify(node.config, null, 2));
  const [connectionRefs, setConnectionRefs] = useState(node.connectionRefs);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [sourceNodeId, setSourceNodeId] = useState('');
  const [sourcePort, setSourcePort] = useState('');
  const [targetPort, setTargetPort] = useState('');
  const fields = useMemo(
    () => schemaFields(definition?.configSchema),
    [definition?.configSchema],
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
  const parsedConfig = parseJson(json);
  const config = isJsonObject(parsedConfig) ? parsedConfig : node.config;
  const initialNumericScratch = useMemo(
    () => numericScratchFor(node.config, fields),
    [fields, node.config],
  );
  const [numericScratch, setNumericScratch] = useState(initialNumericScratch);
  const numericScratchOwners = useRef(new Set<string>());
  const initialOrdinaryScratch = useMemo(
    () => ordinaryFieldScratchFor(node.config, fields),
    [fields, node.config],
  );
  const [ordinaryScratch, setOrdinaryScratch] = useState(
    initialOrdinaryScratch,
  );
  const [ordinaryScratchOwners, setOrdinaryScratchOwners] = useState<
    ReadonlySet<string>
  >(new Set());
  const latestValidJsonConfig = useRef<NodeConfig>(node.config);
  const sourceNode = graph.nodes.find(
    (candidate) => candidate.id === sourceNodeId,
  );
  const sourceDefinition = definitions.find(
    (candidate) =>
      candidate.definition.key === sourceNode?.definition.key &&
      candidate.definition.version === sourceNode.definition.version,
  );
  const initial = useMemo(
    () =>
      JSON.stringify({
        label: node.label ?? '',
        config: node.config,
        connectionRefs: node.connectionRefs,
      }),
    [node.config, node.connectionRefs, node.label],
  );
  const dirty =
    JSON.stringify({ label, config: parseJson(json), connectionRefs }) !==
      initial ||
    (mappingSectionEnabled &&
      JSON.stringify(mappingRows) !== JSON.stringify(initialMappingRows)) ||
    JSON.stringify(numericScratch) !== JSON.stringify(initialNumericScratch) ||
    JSON.stringify(ordinaryScratch) !== JSON.stringify(initialOrdinaryScratch);

  useEffect(() => {
    onFormDirtyChange(dirty);
    return () => {
      onFormDirtyChange(false);
    };
  }, [dirty, onFormDirtyChange]);

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
    const parsed = parseJson(json);
    if (parsed === undefined || !isJsonObject(parsed)) {
      setError('Configuration must be a valid JSON object.');
      return false;
    }
    const reconciled = applyOrdinaryFieldScratch(
      parsed,
      ordinaryScratch,
      ordinaryScratchOwners,
    );
    const numeric = applyNumericScratch(
      reconciled,
      fields,
      numericScratch,
      numericScratchOwners.current,
    );
    if (numeric.config === undefined) {
      setFieldErrors(numeric.errors);
      const firstInvalid = fields.find(
        (field) => numeric.errors[field.key] !== undefined,
      );
      if (firstInvalid !== undefined)
        document
          .getElementById(`config-${node.id}-${firstInvalid.key}`)
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
      config: numeric.config,
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
    setError(undefined);
    setFieldErrors({});
    setMappingErrors({});
    setMappingSectionError(undefined);
    return true;
  }, [
    connectionRefs,
    fields,
    graph,
    json,
    label,
    mappingRows,
    mappingSectionEnabled,
    node.inputMappings,
    node.id,
    numericScratch,
    ordinaryScratch,
    ordinaryScratchOwners,
    transact,
  ]);

  useImperativeHandle(actionRef, () => ({ apply }), [apply]);

  function updateConfigValue(key: string, value: NodeConfig[string]) {
    setOrdinaryScratch((current) => ({ ...current, [key]: value }));
    const parsed = parseJson(json);
    if (!isJsonObject(parsed)) {
      setOrdinaryScratchOwners((current) => new Set(current).add(key));
      return;
    }
    setOrdinaryScratchOwners(
      (current) => new Set([...current].filter((fieldKey) => fieldKey !== key)),
    );
    const next = { ...parsed, [key]: value };
    latestValidJsonConfig.current = next;
    setJson(JSON.stringify(next, null, 2));
  }

  function updateNumericScratch(field: SchemaFieldSpec, value: string) {
    setNumericScratch((current) => ({ ...current, [field.key]: value }));
    const parsed = parseJson(json);
    if (!isJsonObject(parsed)) {
      numericScratchOwners.current.add(field.key);
      return;
    }
    const applied = applyNumericScratch(parsed, [field], {
      [field.key]: value,
    });
    if (applied.config === undefined) {
      numericScratchOwners.current.add(field.key);
      return;
    }
    numericScratchOwners.current.delete(field.key);
    latestValidJsonConfig.current = applied.config;
    setJson(JSON.stringify(applied.config, null, 2));
  }

  function updateAdvancedJson(value: string) {
    setJson(value);
    const parsed = parseJson(value);
    if (!isJsonObject(parsed)) return;
    const previous = latestValidJsonConfig.current;
    latestValidJsonConfig.current = parsed;
    const ordinaryChanges = fields.flatMap((field) => {
      if (field.kind === 'number' || field.kind === 'integer') return [];
      const wasPresent = Object.prototype.hasOwnProperty.call(
        previous,
        field.key,
      );
      const isPresent = Object.prototype.hasOwnProperty.call(parsed, field.key);
      if (
        wasPresent === isPresent &&
        Object.is(previous[field.key], parsed[field.key])
      )
        return [];
      return [[field.key, parsed[field.key]] as const];
    });
    if (ordinaryChanges.length > 0) {
      const changedKeys = new Set(
        ordinaryChanges.map(([fieldKey]) => fieldKey),
      );
      setOrdinaryScratchOwners(
        (current) =>
          new Set(
            [...current].filter((fieldKey) => !changedKeys.has(fieldKey)),
          ),
      );
    }
    if (ordinaryChanges.length > 0)
      setOrdinaryScratch((current) => {
        const next = { ...current };
        for (const [fieldKey, scratchValue] of ordinaryChanges)
          next[fieldKey] = scratchValue;
        return next;
      });
    const numericChanges = fields.flatMap((field) => {
      if (field.kind !== 'number' && field.kind !== 'integer') return [];
      const wasPresent = Object.prototype.hasOwnProperty.call(
        previous,
        field.key,
      );
      const isPresent = Object.prototype.hasOwnProperty.call(parsed, field.key);
      if (
        wasPresent === isPresent &&
        Object.is(previous[field.key], parsed[field.key])
      )
        return [];
      const parsedValue = parsed[field.key];
      return [
        [
          field.key,
          typeof parsedValue === 'number' && Number.isFinite(parsedValue)
            ? String(parsedValue)
            : '',
        ] as const,
      ];
    });
    for (const [fieldKey] of numericChanges)
      numericScratchOwners.current.delete(fieldKey);
    if (numericChanges.length === 0) return;
    setNumericScratch((current) => {
      const next = { ...current };
      for (const [fieldKey, scratchValue] of numericChanges)
        next[fieldKey] = scratchValue;
      return next;
    });
  }

  function connect() {
    const next = connectWorkflowNodes(graph, {
      source: sourceNodeId,
      sourceHandle: sourcePort,
      target: node.id,
      targetHandle: targetPort,
    });
    if (next !== null) transact(next);
  }

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
                ordinaryScratchOwners.has(field.key)
                  ? ordinaryScratch[field.key]
                  : config[field.key]
              }
              nodeId={node.id}
              {...(field.kind === 'number' || field.kind === 'integer'
                ? { scratchValue: numericScratch[field.key] ?? '' }
                : {})}
              {...(fieldErrors[field.key] === undefined
                ? {}
                : { error: fieldErrors[field.key] })}
              disabled={!editable}
              onChange={(value) => {
                updateConfigValue(field.key, value);
              }}
              onScratchChange={(value) => {
                updateNumericScratch(field, value);
                setFieldErrors((current) => {
                  if (current[field.key] === undefined) return current;
                  return Object.fromEntries(
                    Object.entries(current).filter(
                      ([key]) => key !== field.key,
                    ),
                  );
                });
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
          <Field data-invalid={error !== undefined}>
            <FieldLabel htmlFor={`node-config-${node.id}`}>
              Configuration
            </FieldLabel>
            <Textarea
              id={`node-config-${node.id}`}
              name="nodeConfiguration"
              autoComplete="off"
              className="min-h-64 font-mono text-base"
              value={json}
              disabled={!editable}
              aria-invalid={error !== undefined}
              onChange={(event) => {
                updateAdvancedJson(event.currentTarget.value);
              }}
            />
            <FieldDescription>
              {definition === undefined
                ? 'This definition is not in the current catalog. Its complete configuration is preserved.'
                : 'JSON Schema fields are preserved exactly. Advanced JSON covers schemas beyond the first form renderer.'}
            </FieldDescription>
            {error === undefined ? null : <FieldError>{error}</FieldError>}
          </Field>
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
            <FieldGroup className="rounded-lg border border-white/8 bg-black/15 p-3">
              <Field>
                <FieldLabel htmlFor={`source-node-${node.id}`}>
                  Connect from node
                </FieldLabel>
                <select
                  id={`source-node-${node.id}`}
                  name="sourceNode"
                  autoComplete="off"
                  className="recessed-control h-10 rounded-lg border px-3 text-base"
                  value={sourceNodeId}
                  onChange={(event) => {
                    setSourceNodeId(event.currentTarget.value);
                    setSourcePort('');
                  }}
                >
                  <option value="">Choose a source node</option>
                  {graph.nodes
                    .filter((candidate) => candidate.id !== node.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label ?? candidate.definition.key}
                      </option>
                    ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`source-port-${node.id}`}>
                  Source output
                </FieldLabel>
                <select
                  id={`source-port-${node.id}`}
                  name="sourcePort"
                  autoComplete="off"
                  className="recessed-control h-10 rounded-lg border px-3 text-base"
                  value={sourcePort}
                  onChange={(event) => {
                    setSourcePort(event.currentTarget.value);
                  }}
                >
                  <option value="">Choose an output</option>
                  {(sourceDefinition?.ports.outputs ?? []).map((port) => (
                    <option key={port} value={port}>
                      {port}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`target-port-${node.id}`}>
                  Target input
                </FieldLabel>
                <select
                  id={`target-port-${node.id}`}
                  name="targetPort"
                  autoComplete="off"
                  className="recessed-control h-10 rounded-lg border px-3 text-base"
                  value={targetPort}
                  onChange={(event) => {
                    setTargetPort(event.currentTarget.value);
                  }}
                >
                  <option value="">Choose an input</option>
                  {(
                    definition?.ports.inputs ?? Object.keys(node.inputMappings)
                  ).map((port) => (
                    <option key={port} value={port}>
                      {port}
                    </option>
                  ))}
                </select>
              </Field>
              <Button
                type="button"
                variant="outline"
                disabled={
                  sourceNodeId === '' || sourcePort === '' || targetPort === ''
                }
                onClick={connect}
              >
                Connect nodes
              </Button>
            </FieldGroup>
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
                  setJson(JSON.stringify(node.config, null, 2));
                  setConnectionRefs(node.connectionRefs);
                  setMappingRows(initialMappingRows);
                  setNumericScratch(initialNumericScratch);
                  setOrdinaryScratch(initialOrdinaryScratch);
                  numericScratchOwners.current.clear();
                  setOrdinaryScratchOwners(new Set());
                  latestValidJsonConfig.current = node.config;
                  setError(undefined);
                  setFieldErrors({});
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

function SchemaField({
  field,
  value,
  nodeId,
  scratchValue,
  error,
  disabled,
  onChange,
  onScratchChange,
}: Readonly<{
  field: SchemaFieldSpec;
  value: NodeConfig[string] | undefined;
  nodeId: string;
  scratchValue?: string;
  error?: string;
  disabled: boolean;
  onChange: (value: NodeConfig[string]) => void;
  onScratchChange: (value: string) => void;
}>) {
  if (field.kind === 'boolean')
    return (
      <Field>
        <label className="flex items-center gap-3 text-sm">
          <input
            id={`config-${nodeId}-${field.key}`}
            type="checkbox"
            name={`config.${field.key}`}
            checked={value === true}
            disabled={disabled}
            onChange={(event) => {
              onChange(event.currentTarget.checked);
            }}
          />
          {field.label}
        </label>
      </Field>
    );
  if (field.options !== undefined)
    return (
      <Field>
        <FieldLabel htmlFor={`config-${nodeId}-${field.key}`}>
          {field.label}
        </FieldLabel>
        <select
          id={`config-${nodeId}-${field.key}`}
          name={`config.${field.key}`}
          autoComplete="off"
          className="recessed-control h-10 rounded-lg border px-3 text-base"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        >
          <option value="">Choose a value</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>
    );
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={`config-${nodeId}-${field.key}`}>
        {field.label}
      </FieldLabel>
      <Input
        id={`config-${nodeId}-${field.key}`}
        name={`config.${field.key}`}
        autoComplete="off"
        type="text"
        inputMode={
          field.kind === 'number' || field.kind === 'integer'
            ? 'decimal'
            : undefined
        }
        value={
          field.kind === 'number' || field.kind === 'integer'
            ? scratchValue
            : typeof value === 'string' || typeof value === 'number'
              ? String(value)
              : ''
        }
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={
          error === undefined
            ? undefined
            : `config-${nodeId}-${field.key}-error`
        }
        onChange={(event) => {
          if (field.kind === 'number' || field.kind === 'integer')
            onScratchChange(event.currentTarget.value);
          else onChange(event.currentTarget.value);
        }}
      />
      {error === undefined ? null : (
        <FieldError id={`config-${nodeId}-${field.key}-error`}>
          {error}
        </FieldError>
      )}
    </Field>
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
