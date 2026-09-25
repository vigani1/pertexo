import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import {
  CopyIcon,
  CopyPlusIcon,
  EllipsisIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { describeStep, StepTile } from '@/features/catalog/presentation.public';
import { useLiveField } from '../../use-live-field';
import type { NodeFormApi } from '../../model/node-form';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export type StepMenuActions = Readonly<{
  /** Opens quick add for a step connected after this one. */
  onAddAfter: (returnFocus: HTMLElement | null) => void;
  onDuplicate: () => void;
  onCopyId: () => void;
  onDelete: () => void;
  onClose: () => void;
}>;

/**
 * The step's identity: family tile, a label you edit in place (applied as
 * you type), its type and version, and ⋯ for step-level commands.
 */
export function InspectorHeader({
  node,
  definition,
  form,
  actions,
}: Readonly<{
  node: WorkflowNode;
  definition: NodeDefinitionCatalogItem | undefined;
  form: NodeFormApi;
  actions: StepMenuActions;
}>) {
  const step = describeStep(node.definition.key, definition?.family);
  const labelId = `node-label-${node.id}`;
  const label = useLiveField<string | undefined>({
    value: node.label,
    format: (value) => value ?? '',
    parse: (text) => ({
      ok: true,
      value: text.trim() === '' ? undefined : text.trim(),
    }),
    commit: (value) => {
      form.commit({ label: value }, `${node.id}:label`);
    },
    onScratchChange: (scratch) => {
      form.reportScratch('label', scratch);
    },
  });
  const disabled = node.disabled === true;
  const canAddAfter =
    form.editable && (definition?.ports.outputs.length ?? 0) > 0;
  // Quick add opens once the menu has finished closing, so the menu's own
  // focus return can't pull focus out of it; closing it comes back to ⋯.
  const addAfterRequested = useRef(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex items-start gap-3">
      <StepTile step={step} size="lg" />
      <div className="min-w-0 flex-1">
        <label htmlFor={labelId} className="sr-only">
          Label
        </label>
        <input
          id={labelId}
          name="nodeLabel"
          autoComplete="off"
          placeholder={step.name}
          value={label.text}
          disabled={!form.editable}
          className="-mx-1 w-full min-w-0 rounded-sm bg-transparent px-1 font-heading text-lg leading-tight font-semibold tracking-[-0.02em] outline-none placeholder:text-foreground/70 hover:bg-white/4 focus-visible:bg-black/25 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:hover:bg-transparent"
          onChange={(event) => {
            label.change(event.currentTarget.value);
          }}
        />
        <p className="mt-0.5 truncate text-xs text-subtle-foreground">
          {step.name} ·{' '}
          <span className="font-mono">v{node.definition.version}</span>
          {definition === undefined ? ' · not in catalog' : ''}
          {disabled ? ' · disabled' : ''}
        </p>
      </div>
      <DropdownMenu
        onOpenChangeComplete={(open) => {
          if (open || !addAfterRequested.current) return;
          addAfterRequested.current = false;
          actions.onAddAfter(menuTrigger.current);
        }}
      >
        <DropdownMenuTrigger
          ref={menuTrigger}
          aria-label="Step actions"
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            {canAddAfter ? (
              <DropdownMenuItem
                onClick={() => {
                  addAfterRequested.current = true;
                }}
              >
                <PlusIcon aria-hidden="true" />
                Add step after
              </DropdownMenuItem>
            ) : null}
            {form.editable ? (
              <DropdownMenuItem onClick={actions.onDuplicate}>
                <CopyPlusIcon aria-hidden="true" />
                Duplicate
              </DropdownMenuItem>
            ) : null}
            {form.editable ? (
              <DropdownMenuItem
                onClick={() => {
                  form.commit({ disabled: !disabled }, `${node.id}:disabled`);
                }}
              >
                {disabled ? (
                  <PowerIcon aria-hidden="true" />
                ) : (
                  <PowerOffIcon aria-hidden="true" />
                )}
                {disabled ? 'Enable' : 'Disable'}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={actions.onCopyId}>
              <CopyIcon aria-hidden="true" />
              Copy step ID
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {form.editable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={actions.onDelete}
                >
                  <Trash2Icon aria-hidden="true" />
                  Delete step
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Close step panel"
        onClick={actions.onClose}
      >
        <XIcon />
      </Button>
    </div>
  );
}
