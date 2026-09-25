import { useState } from 'react';
import type { GraphLevel, WorkflowNode } from './model/graph-scopes';
import {
  inputMappingRowsFor,
  inputMappingSourceErrors,
  newInputMappingRow,
  validateInputMappingRows,
  type InputMappingDraftRow,
  type InputMappingRowErrors,
} from './model/input-mappings';

type MappingDraft = Readonly<{
  rows: readonly InputMappingDraftRow[];
  /** JSON of the mappings these rows last applied, to spot outside changes. */
  applied: string;
  /** Rows people have left: their problems show and then follow typing. */
  touched: ReadonlySet<string>;
  sequence: number;
}>;

const MAPPINGS_FIELD = 'inputs';

/**
 * A step's input rows under live apply. When every row is complete the
 * whole set applies to the draft as one coalesced edit; otherwise the rows
 * wait here as scratch. Undo or a reload replaces the rows with the draft's.
 */
export function useLiveMappings({
  node,
  graph,
  loopPorts,
  commit,
  reportScratch,
}: Readonly<{
  node: WorkflowNode;
  /** The level the step is on: the workflow, or the body it's in. */
  graph: GraphLevel;
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  commit: (inputMappings: WorkflowNode['inputMappings']) => void;
  reportScratch: (field: string, hasScratch: boolean) => void;
}>) {
  const committed = JSON.stringify(node.inputMappings);
  const [draft, setDraft] = useState<MappingDraft>(() => ({
    rows: inputMappingRowsFor(node.inputMappings),
    applied: committed,
    touched: new Set(),
    sequence: 0,
  }));
  let current = draft;
  if (draft.applied !== committed) {
    current = {
      rows: inputMappingRowsFor(node.inputMappings),
      applied: committed,
      touched: new Set(),
      sequence: draft.sequence,
    };
    setDraft(current);
  }

  function update(
    rows: readonly InputMappingDraftRow[],
    changes: Readonly<{ sequence?: number }> = {},
  ) {
    const { touched } = current;
    const sequence = changes.sequence ?? current.sequence;
    const result = validateInputMappingRows(rows, graph, node.id, {
      checkGraph: false,
    });
    if (result.inputMappings === undefined) {
      setDraft({ rows, applied: current.applied, touched, sequence });
      reportScratch(MAPPINGS_FIELD, true);
      return;
    }
    const applied = JSON.stringify(result.inputMappings);
    setDraft({ rows, applied, touched, sequence });
    reportScratch(MAPPINGS_FIELD, false);
    if (applied !== current.applied) commit(result.inputMappings);
  }

  function addRow(row?: (id: string) => InputMappingDraftRow) {
    const id = `new-${String(current.sequence)}`;
    update([...current.rows, row?.(id) ?? newInputMappingRow(id)], {
      sequence: current.sequence + 1,
    });
    return id;
  }

  const validation = validateInputMappingRows(current.rows, graph, node.id, {
    checkGraph: false,
  });
  const warnings = inputMappingSourceErrors(
    current.rows,
    graph,
    node.id,
    loopPorts,
  );
  const errors: Record<string, InputMappingRowErrors> = {};
  for (const row of current.rows) {
    const rowErrors = current.touched.has(row.id)
      ? validation.errors[row.id]
      : undefined;
    const merged = { ...warnings[row.id], ...rowErrors };
    if (Object.keys(merged).length > 0) errors[row.id] = merged;
  }

  return {
    rows: current.rows,
    errors,
    changeRow: (row: InputMappingDraftRow) => {
      update(
        current.rows.map((candidate) =>
          candidate.id === row.id ? row : candidate,
        ),
      );
    },
    /** Leaving a row's controls shows what's wrong with it. */
    leaveRow: (rowId: string) => {
      if (current.touched.has(rowId)) return;
      setDraft({ ...current, touched: new Set(current.touched).add(rowId) });
    },
    removeRow: (rowId: string) => {
      update(current.rows.filter((row) => row.id !== rowId));
    },
    addRow,
  } as const;
}
