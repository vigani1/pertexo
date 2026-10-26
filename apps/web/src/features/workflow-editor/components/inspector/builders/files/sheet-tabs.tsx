import { sheetNameSchema } from '@pertexo/node-sdk';
import { PlusIcon } from 'lucide-react';
import { FieldError } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import type { FieldParseResult } from '../../../../model/inspector/draft';
import type { NodeFormApi } from '../../../../model/inspector/node-form';
import { useInspectorDraftField } from '../../use-draft-field';

/**
 * The sheet as Excel shows it, a tab under the grid: the chosen name is the
 * open tab and can be typed over. Names a test found in the workbook sit
 * beside it as closed tabs; choosing one fills the name.
 */
export function SheetTabs({
  form,
  input,
  suggestions = [],
  onCommit,
}: Readonly<{
  form: NodeFormApi;
  input: Readonly<{
    id: string;
    label: string;
    value: string | undefined;
    /** Shown while empty; without one, a name is required. */
    placeholder?: string;
  }>;
  suggestions?: readonly string[];
  onCommit: (name: string | undefined) => void;
}>) {
  const optional = input.placeholder !== undefined;
  const live = useInspectorDraftField<string | undefined>({
    value: input.value,
    format: (value) => value ?? '',
    parse: (text) => parseSheetName(text, optional),
    commit: onCommit,
    onScratchChange: (scratch) => {
      form.reportScratch(input.id, scratch);
    },
  });
  const errorId = `${input.id}-error`;
  const others = suggestions.filter((name) => name !== input.value);
  return (
    <>
      <div
        className={cn(
          '-mt-px flex h-9 min-w-0 items-start gap-1 overflow-x-auto overscroll-x-contain pr-1 [scrollbar-width:none]',
          // Fades the last tab so a row wider than the panel reads as scrollable.
          others.length > 0 &&
            'pr-6 [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]',
        )}
      >
        <span className="relative flex h-8 shrink-0 items-center rounded-b-md border border-t-0 border-surface-ink/8 bg-recess-ink/15 px-2.5 shadow-[inset_0_-2px_0_var(--action)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[[aria-invalid=true]]:shadow-[inset_0_-2px_0_var(--destructive)]">
          <input
            id={input.id}
            aria-label={input.label}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            placeholder={input.placeholder}
            value={live.text}
            disabled={!form.editable}
            aria-invalid={live.error !== undefined}
            aria-describedby={live.error === undefined ? undefined : errorId}
            onChange={(event) => {
              live.change(event.currentTarget.value);
            }}
            onBlur={live.blur}
            className="w-36 max-w-48 min-w-14 bg-transparent font-mono supports-[field-sizing:content]:w-auto supports-[field-sizing:content]:[field-sizing:content] text-[0.72rem] font-medium text-foreground outline-none placeholder:font-sans placeholder:font-normal placeholder:text-subtle-foreground disabled:opacity-60"
          />
        </span>
        {others.map((name) => (
          <button
            key={name}
            type="button"
            disabled={!form.editable}
            aria-label={`Use sheet ${name}`}
            title={`Use sheet ${name}`}
            onClick={() => {
              live.change(name);
            }}
            className="flex h-7 max-w-36 shrink-0 items-center gap-1 rounded-b-md border border-t-0 border-dashed border-surface-ink/12 px-2 font-mono text-[0.68rem] text-muted-foreground transition-colors hover:border-action/50 hover:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
          >
            <PlusIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{name}</span>
          </button>
        ))}
      </div>
      {live.error === undefined ? null : (
        <FieldError id={errorId}>{live.error}</FieldError>
      )}
    </>
  );
}

function parseSheetName(
  text: string,
  optional: boolean,
): FieldParseResult<string | undefined> {
  if (text === '')
    return optional
      ? { ok: true, value: undefined }
      : { ok: false, error: 'Name the sheet.' };
  const result = sheetNameSchema.safeParse(text);
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        error:
          text.length > 31
            ? 'Sheet names hold up to 31 characters.'
            : (result.error.issues[0]?.message ?? 'Use another sheet name.'),
      };
}
