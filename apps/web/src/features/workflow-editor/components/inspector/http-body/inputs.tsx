import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useScratchForm } from '../use-draft-field';
import { useState, type ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  ConfirmDialog,
  ConfirmationFooter,
} from '@/components/patterns/actions/confirm-dialog';
import type { FileUploadScope } from '@/features/artifacts/public';
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import {
  bodyValue,
  newFormPart,
  populatedSource,
  type FormPartDraft,
  type HttpBodyDraft,
  type HttpBodyValue,
} from '../../../model/inspector/http-body';
import { useEditorStoreApi } from '../../../model/state/context';
import { findStep } from '../../../model/graph/scopes';
import { useHttpBodyDraft } from './use-draft';
import { MultipartParts } from './parts';
import { focusFormPart } from './focus';

type Props = Readonly<{
  node: WorkflowNode;
  graph: GraphLevel;
  form: NodeFormApi;
  fileScope: FileUploadScope | undefined;
  loopPorts: readonly string[];
  links: ReactNode;
  rawInputs: (form: NodeFormApi) => ReactNode;
}>;
export function HttpBodyInputs(props: Props) {
  const value = bodyValue(props.node);
  if (value === undefined)
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-warning">
          These form settings cannot be shown without changing them. Review
          multipart in Setup → Edit as JSON.
        </p>
        {props.rawInputs(props.form)}
      </div>
    );
  return <BodyInputs {...props} value={value} />;
}
type BodyInputsProps = Props & Readonly<{ value: HttpBodyValue }>;

function BodyInputs(props: BodyInputsProps) {
  const model = useBodyInputs(props);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <ToggleGroup
          aria-label="Body type"
          value={[model.draft.text.mode]}
          disabled={!model.form.editable || model.rawScratch}
          onValueChange={(values) => {
            const next = values[0];
            if (next === 'raw' || next === 'multipart') model.mode(next);
          }}
        >
          <ToggleGroupItem value="raw">Raw body</ToggleGroupItem>
          <ToggleGroupItem value="multipart" disabled={!model.bodyAllowed}>
            Form parts
          </ToggleGroupItem>
        </ToggleGroup>
        {!model.bodyAllowed ? (
          <p className="text-xs text-muted-foreground">
            GET and HEAD cannot send a body. Choose another method to use form
            parts.
          </p>
        ) : null}
      </div>
      {model.draft.text.mode === 'raw' ? (
        model.rawInputs(model.rawForm)
      ) : (
        <>
          <MultipartParts
            parts={model.parts}
            validation={model.draft.validation}

            editable={model.form.editable}

            change={model.change}
            onChangePart={model.changePart}
            onRemove={(part) => {
              model.request({
                apply: () => {
                  const index = model.parts.findIndex(
                    ({ inputKey }) => inputKey === part.inputKey,
                  );
                  model.change(
                    {
                      mode: 'multipart',
                      parts: model.parts.filter(
                        ({ inputKey }) => inputKey !== part.inputKey,
                      ),
                    },
                    `remove:${crypto.randomUUID()}`,
                  );
                  focusFormPart(
                    model.node.id,
                    model.parts[index + 1]?.inputKey ??
                      model.parts[index - 1]?.inputKey,
                  );
                },
                destructive: populatedSource(part.source),
                title: 'Remove this form part?',
                description:
                  'This removes the part and its mapping. Shared file bytes are kept. Undo restores the part.',
                confirmLabel: 'Remove',
              });
            }}
            upload={{ scope: model.fileScope, targetKey: model.signature }}
            context={{
              nodeId: model.node.id,
              graph: model.graph,
              loopPorts: model.loopPorts,
            }}
          />
          {model.links}
        </>
      )}
      <ConfirmDialog
        state={{
          open: model.pending !== undefined,
          onOpenChange: (open) => {
            if (!open) model.setConfirmation(undefined);
          },
          locked: false,
        }}
        title={model.pending?.title ?? 'Replace body'}
        description={model.pending?.description}
        onSubmit={() => {
          const current = findStep(model.store.getState().graph, model.node.id);
          if (
            current !== undefined &&
            JSON.stringify(bodyValue(current)) === JSON.stringify(model.value)
          )
            model.pending?.apply();
          model.setConfirmation(undefined);
        }}
        footer={
          <ConfirmationFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <ProgressButton
              type="submit"
              variant="primary"
              pendingLabel={model.pending?.confirmLabel ?? 'Replace'}
            >
              {model.pending?.confirmLabel ?? 'Replace'}
            </ProgressButton>
          </ConfirmationFooter>
        }
      ></ConfirmDialog>
    </div>
  );
}

function useBodyInputs({
  node,
  graph,
  form,
  fileScope,
  loopPorts,
  links,
  rawInputs,
  value,
}: BodyInputsProps) {
  const draft = useHttpBodyDraft(value, graph, form);
  const store = useEditorStoreApi();
  function change(next: HttpBodyDraft, key: string) {
    draft.change(next, key);
  }
  const { form: rawForm, hasScratch: rawScratch } = useScratchForm(form);
  const [confirmation, setConfirmation] = useState<
    | Readonly<{
        signature: string;
        title: string;
        description: string;
        confirmLabel: string;
        apply: () => void;
      }>
    | undefined
  >();
  const signature = JSON.stringify(draft.text);
  const pending =
    confirmation?.signature === signature ? confirmation : undefined;
  const parts = draft.text.mode === 'multipart' ? draft.text.parts : [];
  const bodyAllowed =
    node.config.method !== 'GET' && node.config.method !== 'HEAD';
  function request({
    apply,
    destructive,
    title,
    description,
    confirmLabel = 'Replace',
  }: Readonly<{
    apply: () => void;
    destructive: boolean;
    title: string;
    description: string;
    confirmLabel?: string | undefined;
  }>) {
    if (destructive)
      setConfirmation({ signature, title, description, confirmLabel, apply });
    else apply();
  }
  function mode(next: 'raw' | 'multipart') {
    if (next === draft.text.mode) return;
    const nextDraft: HttpBodyDraft =
      next === 'raw'
        ? {
            mode: 'raw',
            mappings: value.multipart === undefined ? value.inputMappings : {},
          }
        : { mode: 'multipart', parts: [newFormPart('text')] };
    const populated =
      draft.text.mode === 'raw'
        ? Object.keys(draft.text.mappings).length > 0
        : draft.text.parts.length > 0;
    request({
      apply: () => {
        change(nextDraft, `mode:${crypto.randomUUID()}`);
      },
      destructive: populated,
      title: 'Replace the current body?',
      description:
        'Switching body type replaces its current mappings and form parts. Cancel keeps them; Undo restores a completed change. Shared files are kept.',
    });
  }
  function changePart(next: FormPartDraft, field: string): string | undefined {
    if (field === 'upload') {
      const current = findStep(store.getState().graph, node.id);
      if (
        current === undefined ||
        JSON.stringify(bodyValue(current)) !== JSON.stringify(value)
      )
        return 'The form changed while uploading. Review the current part and choose the file again.';
    }
    if (draft.text.mode !== 'multipart')
      return 'The form part is no longer available.';
    const previous = draft.text.parts.find(
      (part) => part.inputKey === next.inputKey,
    );
    if (previous === undefined) return 'The form part is no longer available.';
    const changedKind =
      previous.kind !== next.kind || previous.source.kind !== next.source.kind;
    request({
      apply: () => {
        change(
          {
            mode: 'multipart',
            parts: parts.map((part) =>
              part.inputKey === next.inputKey ? next : part,
            ),
          },
          field === 'upload' || field === 'kind'
            ? `${field}:${crypto.randomUUID()}`
            : `${next.inputKey}:${field}`,
        );
      },
      destructive:
        field !== 'upload' && changedKind && populatedSource(previous.source),
      title: 'Replace this part’s value?',
      description:
        'The new value source replaces the current value. Cancel keeps it; Undo restores the change.',
    });
    return undefined;
  }

  return {
    draft,
    form,
    rawScratch,
    mode,
    bodyAllowed,
    rawInputs,
    rawForm,
    parts,
    node,
    graph,
    loopPorts,
    fileScope,
    signature,
    change,
    changePart,
    request,
    links,
    pending,
    setConfirmation,
    store,
    value,
  } as const;
}
