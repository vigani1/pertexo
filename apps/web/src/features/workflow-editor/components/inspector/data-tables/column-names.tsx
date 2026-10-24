import { useState, type RefObject } from 'react';
import type { DataTableBindings } from '@pertexo/node-sdk';
import type {
  DataTableDefinition,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import {
  useEditorStore,
  useEditorStoreApi,
} from '../../../model/state/context';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import {
  tableColumnNames,
  isColumnNameReviewCurrent,
} from '../../../model/inspector/data-tables/names';
import {
  tableColumnReferences,
  type ColumnNameReference,
} from '../../../model/inspector/data-tables/references';

type Review = Readonly<{
  graph: WorkflowGraphContract;
  tableId: string;
  bindings: DataTableBindings;
  changes: ReturnType<typeof tableColumnNames>['changes'];
  references: readonly ColumnNameReference[];
}>;
export function TableColumnNames({
  table,
  bindings,
  form,
  returnFocus,
}: Readonly<{
  table: DataTableDefinition;
  bindings: DataTableBindings | undefined;
  form: NodeFormApi;
  returnFocus: RefObject<HTMLButtonElement | null>;
}>) {
  const graph = useEditorStore((state) => state.graph);
  const store = useEditorStoreApi();
  const names = tableColumnNames(table.columns, bindings);
  const [open, setOpen] = useState(false);
  // Retain the review through the closing transition so focus never loses its content early.
  const [review, setReview] = useState<Review>();
  const stale =
    review !== undefined && !isColumnNameReviewCurrent(review, graph, table);
  const action =
    names.changes.length > 1 ? 'Use the new names' : 'Use the new name';
  function startReview() {
    if (names.bindings === undefined) return;
    setReview({
      graph,
      tableId: table.id,
      bindings: names.bindings,
      changes: names.changes,
      references: tableColumnReferences(
        graph,
        form.nodeId,
        names.changes.map((field) => field.alias),
      ),
    });
    setOpen(true);
  }
  function apply() {
    if (
      review === undefined ||
      !form.editable ||
      !isColumnNameReviewCurrent(review, store.getState().graph, table)
    )
      return;
    form.commit(
      (node) => ({
        config: { ...node.config, columnBindings: review.bindings },
      }),
      'table-column-names',
    );
    setOpen(false);
  }
  return (
    <>
      <ul className="grid gap-1 text-xs">
        {names.fields.map(({ alias, name }) => (
          <li key={alias} className="min-w-0 break-words">
            {columnNameLabel(alias, name)}
          </li>
        ))}
      </ul>
      {names.changes.length === 0 ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          disabled={!form.editable || names.missing}
          onClick={startReview}
        >
          {action}
        </Button>
      )}
      {names.missing ? (
        <p className="text-xs text-muted-foreground">
          Review current columns before adopting names; a bound column was
          removed.
        </p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(next) => {
          if (!next) setReview(undefined);
        }}
      >
        {review === undefined ? null : (
          <DialogContent finalFocus={returnFocus}>
            <DialogTitle>Review column names</DialogTitle>
            <DialogDescription>
              Change this draft’s input and output field names to the current
              table names. Each field stays linked to the same column. Published
              versions keep their names.
            </DialogDescription>
            <ul
              className="my-4 grid gap-1 text-sm"
              aria-label="Field name changes"
            >
              {review.changes.map((field) => (
                <li key={field.alias} className="min-w-0 break-words">
                  <code translate="no">{field.alias}</code> →{' '}
                  <code translate="no">{field.name}</code>
                </li>
              ))}
            </ul>
            <Notice tone="warning">
              Review this step’s values, filters and sorting too. Mappings and
              input data are not rewritten. Old paths may break or select a
              different column after names are swapped.
            </Notice>
            <h3 className="mt-4 text-sm font-semibold">
              Later references to review
            </h3>
            <ReviewReferences references={review.references} />
            {open && stale ? (
              <Notice tone="warning">
                The draft or table changed during this review. Close and review
                the names again.
              </Notice>
            ) : null}
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button
                type="button"
                disabled={!form.editable || stale}
                onClick={apply}
              >
                {review.changes.length > 1
                  ? 'Use the new names'
                  : 'Use the new name'}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function columnNameLabel(alias: string, name: string | undefined): string {
  if (name === undefined) return `${alias} (removed column)`;
  return alias === name ? alias : `${alias} (now called ${name})`;
}

function ReviewReferences({
  references,
}: Readonly<{ references: Review['references'] }>) {
  return references.length === 0 ? (
    <p className="mt-2 text-sm text-muted-foreground">
      No later references were found in this draft.
    </p>
  ) : (
    <ul className="mt-2 grid gap-3 text-sm" aria-label="Later references">
      {references.map((reference) => (
        <li
          key={JSON.stringify([
            reference.nodeId,
            reference.input,
            reference.detail,
          ])}
          className="min-w-0 break-words"
        >
          <p className="font-medium">
            {reference.step} → {reference.input}
          </p>
          <p className="text-xs text-muted-foreground">{reference.detail}</p>
        </li>
      ))}
    </ul>
  );
}
