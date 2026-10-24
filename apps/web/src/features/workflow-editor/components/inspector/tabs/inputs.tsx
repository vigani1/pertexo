import type { ReactNode } from 'react';
import { HttpBodyInputs } from '../http-body/inputs';
import { ReadFileUpload } from '../input-mappings/read-file-upload';
import { UploadFile } from '@/features/artifacts/public';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import type { Connection } from '@xyflow/react';
import { PlusIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/ui/use-notifications';
import { useEditorStoreApi } from '../../../model/state/context';
import type { EditorFocusTarget } from '../../../hooks/use-editor-actions';
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import {
  directPredecessorOptions,
  nodeUsesRunInputDirectly,
  type InputMappingDraftRow,
} from '../../../model/inspector/input-mappings/draft';
import { inputKeySuggestions } from '../../../model/inspector/input-mappings/schema';
import { useInputMappingDraft } from '../input-mappings/use-draft';
import { IncomingLinks } from '../incoming-links';
import {
  InsertDataPicker,
  type InsertedSource,
} from '../input-mappings/insert-data-picker';
import { MappingRow } from '../input-mappings/mapping-row';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { httpRequestPlaceholders } from '../../../model/inspector/http-body';

type RowDisclosure = Readonly<{
  /** Rows whose editor is open. */
  open: ReadonlySet<string>;
  /** A row just created here, whose field name takes focus. */
  focusKeyOf?: string | undefined;
  /** The last Fix request this tab has opened a row for. */
  request?: number | undefined;
}>;

/**
 * Inputs: each row reads `field ← source` and opens its editor in place.
 * Rows apply as soon as they're complete; removing one is an ordinary edit,
 * so ⌘Z brings it back. Rows that need attention start open, as do rows
 * made here; Fix opens the row it names. Inside a For each body, rows can
 * also read the item the body runs for.
 */
type InputsTabProps = Readonly<{
  node: WorkflowNode;
  workspaceScope?: WorkspaceApiScope;
  /** The level the step is on: the workflow, or the body it's in. */
  graph: GraphLevel;
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  definition: NodeDefinitionCatalogItem | undefined;
  definitions: readonly NodeDefinitionCatalogItem[];
  form: NodeFormApi;
  focusTarget:
    (EditorFocusTarget & Readonly<{ requestId: number }>) | undefined;
  onConnect: (link: Connection) => void;
  onRemoveEdge: (edgeId: string) => void;
}>;

export function InputsTab(props: InputsTabProps) {
  const links = (
    <IncomingLinks
      node={props.node}
      graph={props.graph}
      definitions={props.definitions}
      editable={props.form.editable}
      onConnect={props.onConnect}
      onRemoveEdge={props.onRemoveEdge}
    />
  );
  return props.node.definition.key === 'http.request' ? (
    <HttpBodyInputs
      node={props.node}
      graph={props.graph}
      form={props.form}
      fileScope={props.workspaceScope}
      loopPorts={props.loopPorts}
      links={links}
      rawInputs={(form) => (
        <MappedInputsTab {...props} form={form} links={links} />
      )}
    />
  ) : (
    <MappedInputsTab {...props} links={links} />
  );
}

function MappedInputsTab({
  node,
  workspaceScope,
  graph,
  loopPorts,
  definition,
  definitions,
  form,
  focusTarget,
  links,
}: InputsTabProps & Readonly<{ links: ReactNode }>) {
  const activeRowId = useRef<string | undefined>(undefined);
  const store = useEditorStoreApi();
  const notifications = useNotifications();
  const mappings = useInputMappingDraft({
    node,
    graph,
    loopPorts,
    commit: (inputMappings) => {
      form.commit({ inputMappings }, `${node.id}:inputs`);
    },
    reportScratch: form.reportScratch,
  });
  const rowsShown = useRowDisclosure(mappings, node.id, focusTarget);
  const editable = form.editable && definition !== undefined;
  const suggestions = [
    ...inputKeySuggestions(definition?.inputSchema),
    ...httpRequestPlaceholders(node).map((name) => ({
      key: name,
      label: `{${name}}`,
      description: 'A value filled into the request address or headers',
      type: 'string' as const,
    })),
  ];
  const predecessors = directPredecessorOptions(graph, node.id);
  if (nodeUsesRunInputDirectly(node.definition))
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          This trigger receives the run’s input directly, so it has no inputs to
          map.
        </p>
        {links}
      </div>
    );

  function openRow({
    rowId,
    focusKey,
  }: Readonly<{ rowId: string; focusKey: boolean }>) {
    activeRowId.current = rowId;
    rowsShown.openRow({ rowId, focusKey });
  }

  /** Fills the open row you were editing, or adds one named after the field. */
  function insert(source: InsertedSource, fieldName: string) {
    const active = mappings.rows.find(
      (row) => row.id === activeRowId.current && rowsShown.open.has(row.id),
    );
    const withSource = (
      base: Pick<InputMappingDraftRow, 'id' | 'destinationKey'>,
    ): InputMappingDraftRow => ({ ...base, ...source });
    if (active !== undefined) {
      mappings.changeRow(
        withSource({ id: active.id, destinationKey: active.destinationKey }),
      );
      return;
    }
    const taken = mappings.rows.some((row) => row.destinationKey === fieldName);
    const key = taken ? '' : fieldName;
    const id = mappings.addRow((rowId) =>
      withSource({ id: rowId, destinationKey: key }),
    );
    openRow({ rowId: id, focusKey: key === '' });
  }

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Inputs" className="flex flex-col gap-3">
        {mappings.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-surface-ink/10 p-3 text-sm text-muted-foreground">
            No input mappings yet. Add a value, part of the run input, or the
            output of a step linked before this one.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {mappings.rows.map((row) => (
              <MappingRow
                key={row.id}
                nodeId={node.id}
                row={row}
                graph={graph}
                open={rowsShown.open.has(row.id)}
                focusKey={rowsShown.focusKeyOf === row.id}
                onToggle={() => {
                  rowsShown.toggleRow(row.id);
                }}
                suggestions={suggestions}
                predecessors={predecessors}
                loopPorts={loopPorts}
                errors={mappings.errors[row.id]}
                disabled={!editable}
                onChange={mappings.changeRow}
                onRemove={() => {
                  const before = store.getState().generation;
                  mappings.removeRow(row.id);
                  const after = store.getState().generation;
                  if (after === before) return;
                  notifications.undo({
                    title:
                      row.destinationKey === ''
                        ? 'Input removed'
                        : `Removed the “${row.destinationKey}” input`,
                    onUndo: () => {
                      if (store.getState().generation === after)
                        store.getState().undo();
                    },
                  });
                }}
                onFocusRow={() => {
                  activeRowId.current = row.id;
                }}
                onLeaveRow={() => {
                  mappings.leaveRow(row.id);
                }}
              />
            ))}
          </ol>
        )}
        {workspaceScope !== undefined &&
        node.definition.key === 'core.read_file' ? (
          <ReadFileUpload
            scope={workspaceScope}
            node={node}
            form={form}
            hasScratch={mappings.hasScratch}
          />
        ) : null}
        {workspaceScope !== undefined &&
        node.definition.key === 'http.request' &&
        node.config.method !== 'GET' &&
        node.config.method !== 'HEAD' ? (
          <UploadFile
            targetKey={JSON.stringify(node.inputMappings)}
            scope={workspaceScope}
            disabled={!editable || mappings.hasScratch}
            label="Upload body file"
            useLabel={
              node.inputMappings.body === undefined
                ? 'Use file as body'
                : 'Replace body with file'
            }
            description="Send this file’s exact bytes as the HTTP request body. Using it replaces the current body mapping."
            onUse={(reference) => {
              form.commit(
                (current) => ({
                  inputMappings: {
                    ...current.inputMappings,
                    body: { kind: 'literal', value: reference },
                  },
                }),
                `${node.id}:file:${reference.artifactId}`,
              );
              return undefined;
            }}
          />
        ) : null}
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                openRow({ rowId: mappings.addRow(), focusKey: true });
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Add input
            </Button>
            <InsertDataPicker
              {...(workspaceScope === undefined
                ? {}
                : {
                    variableScope: {
                      apiClient: workspaceScope.apiClient,
                      userId: workspaceScope.userId,
                      workspaceId: workspaceScope.workspaceId,
                    },
                  })}
              graph={graph}
              nodeId={node.id}
              loopPorts={loopPorts}
              definitions={definitions}
              disabled={!editable}
              onInsert={insert}
            />
          </div>
        ) : null}
      </section>
      {links}
    </div>
  );
}

/**
 * Which rows show their editor. Rows that need attention start open; a Fix
 * request naming a row's field opens it during the render that receives it,
 * so the inspector can focus the field right after.
 */
function useRowDisclosure(
  mappings: Readonly<{
    rows: readonly InputMappingDraftRow[];
    errors: Readonly<Record<string, unknown>>;
  }>,
  nodeId: string,
  focusTarget:
    (EditorFocusTarget & Readonly<{ requestId: number }>) | undefined,
) {
  const [disclosure, setDisclosure] = useState<RowDisclosure>(() => ({
    open: new Set(Object.keys(mappings.errors)),
  }));
  let shown = disclosure;
  if (
    focusTarget?.nodeId === nodeId &&
    focusTarget.mappingKey !== undefined &&
    focusTarget.requestId !== disclosure.request
  ) {
    const fixed = mappings.rows.find(
      (row) => row.destinationKey === focusTarget.mappingKey,
    );
    shown = {
      ...disclosure,
      open:
        fixed === undefined
          ? disclosure.open
          : new Set(disclosure.open).add(fixed.id),
      request: focusTarget.requestId,
    };
    setDisclosure(shown);
  }
  return {
    open: shown.open,
    focusKeyOf: shown.focusKeyOf,
    openRow: ({
      rowId,
      focusKey,
    }: Readonly<{ rowId: string; focusKey: boolean }>) => {
      setDisclosure((current) => ({
        ...current,
        open: new Set(current.open).add(rowId),
        focusKeyOf: focusKey ? rowId : current.focusKeyOf,
      }));
    },
    toggleRow: (rowId: string) => {
      setDisclosure((current) => {
        const open = new Set(current.open);
        if (!open.delete(rowId)) open.add(rowId);
        return {
          ...current,
          open,
          focusKeyOf:
            current.focusKeyOf === rowId ? undefined : current.focusKeyOf,
        };
      });
    },
  } as const;
}
