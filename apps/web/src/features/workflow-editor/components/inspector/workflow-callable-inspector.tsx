import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import {
  useEditorStore,
  useEditorStoreApi,
} from '../../model/editor-store-context';
import {
  callableDeclaration,
  emptyCallableDeclaration,
  setCallableDeclaration,
  type CallableDeclaration,
} from '../../model/graph/callable-contract';
import { CallableTypeEditor } from './callable-type-editor';
import { CallableResultSourceEditor } from './callable-result-source-editor';
import { createScratchTracker } from './use-inspector-draft-field';

/** Applied values live only in the editor graph, not a second form. */
export function WorkflowCallableInspector({
  editable,
  onDiscardScratch,
  onClose,
}: Readonly<{
  editable: boolean;
  onDiscardScratch: () => void;
  onClose: () => void;
}>) {
  const store = useEditorStoreApi();
  const declaration = useEditorStore((state) =>
    callableDeclaration(state.graph),
  );
  const scratch = useEditorStore((state) => state.inspectorScratch);
  const [reportScratch] = useState(() =>
    createScratchTracker((hasScratch) => {
      store.getState().setInspectorScratch(hasScratch);
    }),
  );
  function update(change: Partial<CallableDeclaration>, field: string) {
    const state = store.getState();
    const current = callableDeclaration(state.graph);
    if (!editable || current === undefined) return;
    state.transact(
      setCallableDeclaration(state.graph, { ...current, ...change }),
      { coalesceKey: `callable:${field}` },
    );
  }
  return (
    <section
      aria-label="Callable contract"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-heading text-lg font-semibold">
            Callable contract
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The inputs this workflow accepts and the object it returns to its
            caller.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <Notice title="Draft authoring only">
        Native publishing and execution are not enabled. Adding a contract saves
        a native draft; it does not activate calls or change a published
        version.
      </Notice>
      {declaration === undefined ? (
        <Button
          type="button"
          variant="outline"
          disabled={!editable}
          onClick={() => {
            if (!editable) return;
            const state = store.getState();
            state.transact(
              setCallableDeclaration(state.graph, emptyCallableDeclaration()),
            );
          }}
        >
          Add callable contract
        </Button>
      ) : (
        <>
          <FieldGroup>
            <CallableTypeEditor
              id="callable-input-type"
              label="Input type"
              value={declaration.input}
              editable={editable}
              onScratchChange={(value) => {
                reportScratch('input', value);
              }}
              onChange={(input) => {
                update({ input }, 'input');
              }}
            />
            <CallableTypeEditor
              id="callable-result-type"
              label="Result type"
              value={declaration.result}
              editable={editable}
              onScratchChange={(value) => {
                reportScratch('result', value);
              }}
              onChange={(result) => {
                update({ result }, 'result');
              }}
            />
            <CallableResultSourceEditor
              value={declaration.resultSelector}
              editable={editable}
              onScratchChange={(value) => {
                reportScratch('source', value);
              }}
              onChange={(resultSelector) => {
                update({ resultSelector }, 'source');
              }}
            />
          </FieldGroup>
          {scratch ? (
            <Notice
              tone="warning"
              title="Unapplied contract text"
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onDiscardScratch}
                >
                  Discard unapplied text
                </Button>
              }
            >
              Fix the invalid text or discard it before leaving this panel. Only
              applied values are saved.
            </Notice>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={!editable || scratch}
            onClick={() => {
              if (!editable || scratch) return;
              const state = store.getState();
              state.transact(setCallableDeclaration(state.graph, undefined));
            }}
          >
            Remove callable contract
          </Button>
          <p className="text-xs text-muted-foreground">
            Removing the contract keeps the native graph format and all steps.
            Undo restores the declaration.
          </p>
        </>
      )}
    </section>
  );
}
