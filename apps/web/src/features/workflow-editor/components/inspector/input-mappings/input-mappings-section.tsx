import { Button } from '@/components/ui/button';
import { FieldDescription, FieldError } from '@/components/ui/field';
import type {
  InputKeySuggestion,
  InputMappingDraftRow,
  InputMappingRowErrors,
  PredecessorOption,
} from '../../../model/input-mappings';
import { InputMappingRow } from './input-mapping-row';

export function InputMappingsSection({
  nodeId,
  rows,
  suggestions,
  predecessors,
  errors,
  sectionError,
  editable,
  onRowsChange,
  onAdd,
}: Readonly<{
  nodeId: string;
  rows: readonly InputMappingDraftRow[];
  suggestions: readonly InputKeySuggestion[];
  predecessors: readonly PredecessorOption[];
  errors: Readonly<Record<string, InputMappingRowErrors>>;
  sectionError?: string;
  editable: boolean;
  onRowsChange: (rows: readonly InputMappingDraftRow[]) => void;
  onAdd: () => void;
}>) {
  return (
    <section
      className="rounded-xl border border-white/8 bg-card/35 p-3"
      aria-labelledby={`input-mappings-${nodeId}-title`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id={`input-mappings-${nodeId}-title`}
            className="font-heading text-base font-semibold"
          >
            Inputs
          </h3>
          <FieldDescription className="mt-1">
            Map execution values into top-level node inputs. Edges only control
            routing; configuration remains separate.
          </FieldDescription>
        </div>
        {editable ? (
          <Button type="button" size="sm" variant="outline" onClick={onAdd}>
            Add input
          </Button>
        ) : null}
      </div>
      {sectionError === undefined ? null : (
        <FieldError className="mt-3">{sectionError}</FieldError>
      )}
      {rows.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-white/10 p-3 text-sm text-muted-foreground">
          No input mappings. Add a literal, run input path or directly connected
          node output.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-3">
          {rows.map((row, index) => (
            <InputMappingRow
              key={row.id}
              nodeId={nodeId}
              row={row}
              index={index}
              suggestions={suggestions}
              predecessors={predecessors}
              {...(errors[row.id] === undefined
                ? {}
                : { errors: errors[row.id] })}
              disabled={!editable}
              onChange={(nextRow) => {
                onRowsChange(
                  rows.map((candidate) =>
                    candidate.id === row.id ? nextRow : candidate,
                  ),
                );
              }}
              onRemove={() => {
                onRowsChange(
                  rows.filter((candidate) => candidate.id !== row.id),
                );
              }}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
