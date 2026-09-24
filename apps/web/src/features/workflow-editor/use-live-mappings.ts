import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { useState } from 'react';
import {
  inputMappingRowsFor,
  inputMappingSourceErrors,
  newInputMappingRow,
  validateInputMappingRows,
  type InputMappingDraftRow,
  type InputMappingRowErrors,
} from './model/input-mappings';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

type MappingDraft = Readonly<{
  rows: readonly InputMappingDraftRow[];
  /** JSON of the mappings these rows last applied, to spot outside changes. */
  applied: string;
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
  commit,
  reportScratch,
}: Readonly<{
  node: WorkflowNode;
  graph: WorkflowGraphContract;
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
    changes: Readonly<{ touchedRowId?: string; sequence?: number }> = {},
  ) {
    const touched =
      changes.touchedRowId === undefined
        ? current.touched
        : new Set(current.touched).add(changes.touchedRowId);
    const sequence = changes.sequence ?? current.sequence;
    const result = validateInputMappingRows(rows, graph, node.id, {
      requireDirectPredecessor: false,
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
    requireDirectPredecessor: false,
  });
  const warnings = inputMappingSourceErrors(current.rows, graph, node.id);
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
        { touchedRowId: row.id },
      );
    },
    removeRow: (rowId: string) => {
      update(current.rows.filter((row) => row.id !== rowId));
    },
    addRow,
  } as const;
}
