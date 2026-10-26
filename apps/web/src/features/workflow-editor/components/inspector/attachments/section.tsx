import { EMAIL_SEND_NOTIFICATION_LIMITS } from '@pertexo/integrations';
import type { ValueSource } from '@pertexo/workflow-model';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { useNotifications } from '@/components/ui/use-notifications';
import { useRemovalFocus } from '@/lib/hooks/use-removal-focus';
import { UploadFile } from '@/features/artifacts/public';
import { describeStep, StepTile } from '@/features/catalog/presentation.public';
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import {
  ATTACHMENTS_KEY,
  attachmentName,
  attachmentsDraft,
  attachmentsSize,
  newAttachment,
  type AttachmentDraft,
} from '../../../model/inspector/object-mappings/attachments';
import { useEditorStoreApi } from '../../../model/state/context';
import { MappingValueEditor } from '../input-mappings/value-editor';
import {
  directPredecessorOptions,
  type InputMappingDraftRow,
} from '../../../model/inspector/input-mappings/draft';
import { useInspectorSession } from '../use-session';
import { AttachPicker } from './attach-picker';
import { AttachmentRow } from './attachment-row';
import { AttachmentSizeMeter } from './size-meter';
import { useAttachmentsDraft } from './use-draft';

type Props = Readonly<{
  node: WorkflowNode;
  graph: GraphLevel;
  loopPorts: readonly string[];
  form: NodeFormApi;
}>;

const { maxAttachments } = EMAIL_SEND_NOTIFICATION_LIMITS;

/**
 * Send email's Attachments, under the message: each file is a chip mapped
 * from an earlier step, the run input or an upload, with a size meter that
 * fills toward the email's limit.
 */
export function EmailAttachments({ node, graph, loopPorts, form }: Props) {
  const headingId = useId();
  const model = useAttachments({ node, graph, form });
  const { text } = model.draft;
  const context = { nodeId: node.id, graph, loopPorts };
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 border-t border-surface-ink/7 pt-5"
      onBlurCapture={model.draft.blur}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={headingId} className="text-[0.8rem] font-semibold">
          Attachments
        </h3>
        {text.mode === 'files' ? (
          <span className="font-mono text-[0.66rem] text-subtle-foreground tabular-nums">
            {text.rows.length} / {maxAttachments}
          </span>
        ) : null}
      </div>
      {text.mode === 'list' ? (
        <WholeList
          source={text.source}
          editable={form.editable}
          context={context}
          onChange={(source) => {
            model.draft.change({ mode: 'list', source });
          }}
          onSeparate={() => {
            model.draft.change({ mode: 'files', rows: [] });
          }}
        />
      ) : (
        <AttachmentList model={model} context={context} />
      )}
      {model.draft.error === undefined ? null : (
        <Notice tone="destructive">{model.draft.error}</Notice>
      )}
      {text.mode === 'files' ? (
        <AttachActions model={model} graph={graph} />
      ) : null}
    </section>
  );
}

type AttachmentsModel = ReturnType<typeof useAttachments>;

function AttachmentList({
  model,
  context,
}: Readonly<{
  model: AttachmentsModel;
  context: Readonly<{
    nodeId: string;
    graph: GraphLevel;
    loopPorts: readonly string[];
  }>;
}>) {
  const rows = model.rows;
  const size = attachmentsSize(rows);
  return (
    <>
      {rows.length === 0 ? (
        <EmptyAttachments />
      ) : (
        <ol className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <AttachmentRow
              key={row.id}
              row={row}
              position={{ index, count: rows.length }}
              error={
                model.draft.shown ? model.draft.rowErrors[row.id] : undefined
              }
              editable={model.form.editable}
              open={model.open.has(row.id)}
              context={context}
              onToggle={() => {
                model.toggle(row.id);
              }}
              onChange={model.replace}
              removeRef={model.focus.removeButton(row.id)}
              onRemove={() => {
                model.remove(row, index);
              }}
            />
          ))}
        </ol>
      )}
      <AttachmentSizeMeter size={size} />
      {size.over ? (
        <p className="text-xs text-destructive">
          These files are over the limit for one email, so the step won’t send
          them. Remove a file or split them across several emails.
        </p>
      ) : null}
    </>
  );
}

/** Holds one chip's height, so the first file takes its place without a jump. */
function EmptyAttachments() {
  return (
    <div className="flex h-13 min-w-0 items-center gap-3 rounded-lg border border-dashed border-border-strong px-2.5 text-[0.8rem]">
      <StepTile step={describeStep('email.send_notification')} size="sm" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium">
          Attach a file from an earlier step
        </span>
        <span className="truncate text-xs text-subtle-foreground">
          A report, an upload or a saved response.
        </span>
      </div>
    </div>
  );
}

function AttachActions({
  model,
  graph,
}: Readonly<{ model: AttachmentsModel; graph: GraphLevel }>) {
  const { definitions, workspaceScope } = useInspectorSession();
  const full = model.rows.length >= maxAttachments;
  const disabled = !model.form.editable || full;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <AttachPicker
          triggerRef={model.focus.fallback}
          graph={graph}
          nodeId={model.form.nodeId}
          definitions={definitions}
          disabled={disabled}
          onPick={model.add}
          onPickList={model.attachList}
        />
        <UploadFile
          scope={workspaceScope}
          targetKey={`${model.form.nodeId}:attachments`}
          disabled={disabled}
          label="Upload a file"
          useLabel="Attach this file"
          description="Attach the same file to every email, such as terms or a price list. Its local name isn’t saved; name it in the attachment."
          onUse={(reference) => {
            model.add({ kind: 'literal', value: reference });
            return undefined;
          }}
        />
      </div>
      {full ? (
        <p className="text-xs text-muted-foreground">
          An email carries up to {maxAttachments} files. Remove one to attach
          another.
        </p>
      ) : null}
    </div>
  );
}

/** Attachments mapped as one list, such as a Code step's files. */
function WholeList({
  source,
  editable,
  context,
  onChange,
  onSeparate,
}: Readonly<{
  source: InputMappingDraftRow;
  editable: boolean;
  context: Readonly<{
    nodeId: string;
    graph: GraphLevel;
    loopPorts: readonly string[];
  }>;
  onChange: (source: InputMappingDraftRow) => void;
  onSeparate: () => void;
}>) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        These attachments come from one list. Each item needs a{' '}
        <code className="font-mono text-[0.78rem]">file</code> and may have a{' '}
        <code className="font-mono text-[0.78rem]">filename</code>.
      </p>
      <MappingValueEditor
        row={source}
        type="array"
        error={undefined}
        disabled={!editable}
        onChange={onChange}
        context={{
          ...context,
          predecessors: directPredecessorOptions(context.graph, context.nodeId),
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={!editable}
        onClick={onSeparate}
      >
        Attach files one by one
      </Button>
    </div>
  );
}

function useAttachments({
  node,
  graph,
  form,
}: Pick<Props, 'node' | 'graph' | 'form'>) {
  const draft = useAttachmentsDraft(
    node.inputMappings[ATTACHMENTS_KEY],
    graph,
    form,
  );
  const store = useEditorStoreApi();
  const notifications = useNotifications();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const focus = useRemovalFocus<HTMLButtonElement>();
  const rows = draft.text.mode === 'files' ? draft.text.rows : [];
  function change(next: readonly AttachmentDraft[]) {
    draft.change({ mode: 'files', rows: next });
  }
  function toggle(rowId: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  }
  return {
    draft,
    form,
    rows,
    open,
    focus,
    toggle,
    add: (source: ValueSource | undefined) => {
      const row = newAttachment(source);
      change([...rows, row]);
      // A source still to choose opens where it is chosen.
      if (source === undefined) toggle(row.id);
    },
    /** Attaches a whole list in place of the files attached one by one. */
    attachList: (source: ValueSource) => {
      const before = store.getState().generation;
      draft.change(attachmentsDraft(source));
      const after = store.getState().generation;
      if (rows.length === 0 || after === before) return;
      notifications.undo({
        title:
          rows.length === 1
            ? 'Replaced the attachment'
            : `Replaced ${String(rows.length)} attachments`,
        onUndo: () => {
          if (store.getState().generation === after) store.getState().undo();
        },
      });
    },
    replace: (row: AttachmentDraft) => {
      change(rows.map((current) => (current.id === row.id ? row : current)));
    },
    remove: (row: AttachmentDraft, index: number) => {
      focus.removing(
        rows.map((each) => each.id),
        row.id,
      );
      const before = store.getState().generation;
      change(rows.filter((current) => current.id !== row.id));
      const after = store.getState().generation;
      if (after === before) return;
      const { name } = attachmentName(row, { index, count: rows.length });
      notifications.undo({
        title: `Removed ${name ?? `attachment ${String(index + 1)}`}`,
        onUndo: () => {
          if (store.getState().generation === after) store.getState().undo();
        },
      });
    },
  } as const;
}
