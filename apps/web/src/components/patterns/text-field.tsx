import type { ComponentProps, ReactNode } from 'react';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** The validation thread under a control: frayed, or briefly knotted. */
export type FieldThreadState = 'invalid' | 'corrected' | undefined;

export type TextFieldProps = Readonly<{
  id: string;
  label: ReactNode;
  error?: string | undefined;
  state?: FieldThreadState;
  description?: ReactNode;
  /** A small action on the label row, e.g. "Forgot?". */
  labelAction?: ReactNode;
  /** A control inside the input's right edge, e.g. show/hide. */
  trailing?: ReactNode;
  /** Extra feedback between the control and its description. */
  children?: ReactNode;
}> &
  Omit<ComponentProps<typeof Input>, 'id' | 'children'>;

/** One labelled input with Weft's fray/knot thread and linked messages. */
export function TextField({
  id,
  label,
  error,
  state,
  description,
  labelAction,
  trailing,
  children,
  className,
  'aria-describedby': describedBy,
  ...inputProps
}: TextFieldProps) {
  const descriptionId = description === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedByIds =
    [describedBy, descriptionId, errorId].filter(Boolean).join(' ') ||
    undefined;
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <div className="flex items-baseline justify-between gap-3">
        <FieldLabel
          htmlFor={id}
          className="text-[0.8rem] font-semibold text-foreground/85 group-data-[invalid=true]/field:text-destructive"
        >
          {label}
        </FieldLabel>
        {labelAction}
      </div>
      <FieldControl state={state}>
        <Input
          id={id}
          aria-describedby={describedByIds}
          className={cn('h-10', trailing !== undefined && 'pr-11', className)}
          {...inputProps}
        />
        {trailing === undefined ? null : (
          <div className="absolute inset-y-0 right-1 flex items-center">
            {trailing}
          </div>
        )}
      </FieldControl>
      {children}
      {description === undefined ? null : (
        <FieldDescription id={descriptionId} className="text-[0.8rem]">
          {description}
        </FieldDescription>
      )}
      {error === undefined ? null : (
        <FieldError id={errorId} className="text-[0.8rem]">
          {error}
        </FieldError>
      )}
    </Field>
  );
}
