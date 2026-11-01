import { ChevronRightIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { FieldNode } from '../../../../model/inspector/input-mappings/fields';

export type FieldPick = (
  path: string,
  fieldName: string,
  type: string | undefined,
) => void;

const FIELD_LIST = 'mt-1 ml-3 flex flex-col border-l border-surface-ink/8 pl-2';

/** A source's whole value, then its fields, then anything else it offers. */
export function FieldList({
  fields,
  more = 0,
  wholeLabel = 'Whole output',
  onPick,
  children,
}: Readonly<{
  fields: readonly FieldNode[];
  /** Fields beyond what the list shows. */
  more?: number;
  wholeLabel?: string;
  onPick: FieldPick;
  /** More choices from the same source, such as a form's files. */
  children?: ReactNode;
}>) {
  return (
    <ul className={FIELD_LIST}>
      <li>
        <PickButton
          label={wholeLabel}
          type="object"
          onClick={() => {
            onPick('$', '', 'object');
          }}
        />
      </li>
      <FieldRows fields={fields} more={more} onPick={onPick} open />
      {children}
    </ul>
  );
}

function FieldRows({
  fields,
  more,
  onPick,
  open,
}: Readonly<{
  fields: readonly FieldNode[];
  more: number;
  onPick: FieldPick;
  /** Top-level fields start open: that's where people look first. */
  open: boolean;
}>) {
  return (
    <>
      {fields.map((field) => (
        <FieldRow key={field.path} field={field} onPick={onPick} open={open} />
      ))}
      {more > 0 ? (
        <li className="px-1.5 py-1 text-xs text-subtle-foreground">
          And {more} more. Use an expression to read them.
        </li>
      ) : null}
    </>
  );
}

function FieldRow({
  field,
  onPick,
  open: startOpen,
}: Readonly<{ field: FieldNode; onPick: FieldPick; open: boolean }>) {
  const [open, setOpen] = useState(startOpen);
  const childrenId = useId();
  const hasChildren = field.children.length > 0;
  const name = field.label ?? field.key;
  return (
    <li>
      <div className="flex items-center">
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={childrenId}
            aria-label={`${open ? 'Hide' : 'Show'} the fields in ${name}`}
            className="grid size-6 shrink-0 place-items-center rounded-sm text-subtle-foreground outline-none hover:bg-surface-ink/5 focus-ring pointer-coarse:size-9"
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn('size-3.5', open && 'rotate-90')}
            />
          </button>
        ) : (
          <span
            aria-hidden="true"
            className="size-6 shrink-0 pointer-coarse:w-9"
          />
        )}
        <div className="min-w-0 flex-1">
          <PickButton
            label={name}
            {...(field.type === undefined ? {} : { type: field.type })}
            {...(field.preview === undefined ? {} : { preview: field.preview })}
            onClick={() => {
              onPick(field.path, field.key, field.type);
            }}
          />
        </div>
      </div>
      {hasChildren && open ? (
        <ul id={childrenId} className={FIELD_LIST}>
          <FieldRows
            fields={field.children}
            more={field.more}
            onPick={onPick}
            open={false}
          />
        </ul>
      ) : null}
    </li>
  );
}

export function PickButton({
  label,
  type,
  preview,
  onClick,
}: Readonly<{
  label: string;
  type?: string;
  /** The value it held in real output. */
  preview?: string;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      className="flex min-h-7 w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-[0.8rem] text-muted-foreground outline-none hover:bg-surface-ink/5 hover:text-accent-foreground focus-ring pointer-coarse:min-h-10"
      onClick={onClick}
    >
      <span className="min-w-0 truncate font-medium">{label}</span>
      <span className="min-w-0 flex-[1_1_0] truncate text-right font-mono text-[0.7rem] text-subtle-foreground">
        {preview}
      </span>
      {type === undefined ? null : (
        <span className="shrink-0 font-mono text-[0.66rem] text-subtle-foreground">
          {type}
        </span>
      )}
    </button>
  );
}
