import { useId, useRef, useState } from 'react';
import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { PatternGlyph } from '@/features/workflows/shape.public';
import { formatDate } from '@/lib/format-time';
import { stepCountLabel } from '../../model/version-steps';
import { VersionDiffSummary } from './version-diff-summary';

function versionLabel(version: WorkflowVersionResponse): string {
  return `v${String(version.versionNumber)} · ${formatDate(version.publishedAt)}`;
}

function VersionPicker({
  label,
  versions,
  value,
  onChange,
}: Readonly<{
  label: string;
  versions: readonly WorkflowVersionResponse[];
  value: WorkflowVersionResponse;
  onChange: (version: WorkflowVersionResponse) => void;
}>) {
  const labelId = useId();
  const items = versions.map((version) => ({
    value: version.id,
    label: versionLabel(version),
  }));
  return (
    <Field className="min-w-0 flex-1">
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <Select
        items={items}
        value={value.id}
        onValueChange={(next) => {
          const chosen = versions.find((version) => version.id === next);
          if (chosen !== undefined) onChange(chosen);
        }}
      >
        <SelectTrigger aria-labelledby={labelId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="weave mt-1 grid place-items-center rounded-lg border border-border px-3 py-4">
        <PatternGlyph graph={value.graph} size="card" />
        <span className="mt-2 text-xs text-subtle-foreground">
          {stepCountLabel(value.graph.nodes.length)}
        </span>
      </div>
    </Field>
  );
}

/**
 * Any two published versions side by side, with the steps added, removed or
 * changed between them. Starts from the previous version to the newest.
 */
function VersionComparison({
  versions,
}: Readonly<{ versions: readonly WorkflowVersionResponse[] }>) {
  const newest = versions[0];
  const [from, setFrom] = useState(versions[1] ?? newest);
  const [to, setTo] = useState(newest);
  if (from === undefined || to === undefined) return null;
  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row">
        <VersionPicker
          label="From"
          versions={versions}
          value={from}
          onChange={setFrom}
        />
        <VersionPicker
          label="To"
          versions={versions}
          value={to}
          onChange={setTo}
        />
      </div>
      <section aria-live="polite" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">
          Changes from v{String(from.versionNumber)} to v
          {String(to.versionNumber)}
        </h3>
        {from.id === to.id ? (
          <p className="text-sm text-muted-foreground">
            Pick two different versions to see what changed.
          </p>
        ) : (
          <VersionDiffSummary from={from} to={to} />
        )}
      </section>
    </>
  );
}

/** Compares any two published versions of this workflow. */
export function VersionCompareSheet({
  open,
  versions,
  onClose,
}: Readonly<{
  open: boolean;
  /** Newest first. */
  versions: readonly WorkflowVersionResponse[];
  onClose: () => void;
}>) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        initialFocus={closeRef}
        className="w-[min(36rem,calc(100vw-1.5rem))]"
      >
        <SheetHeader>
          <SheetTitle>Compare versions</SheetTitle>
          <SheetDescription>
            Steps added, removed or changed between two published versions.
            Moving a step on the canvas isn’t a change.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-6">
          {open ? <VersionComparison versions={versions} /> : null}
        </SheetBody>
        <SheetFooter>
          <SheetClose
            render={<Button ref={closeRef} type="button" variant="ghost" />}
          >
            Close
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
