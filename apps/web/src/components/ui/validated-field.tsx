import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
} from './field';
import type { FieldThread } from './use-field-validation';

export type ValidatedControlProps = Readonly<{
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}>;

/**
 * One labelled control with its hint, its message and the validation thread.
 * The control is rendered by the caller with the returned accessibility props,
 * so any input, textarea or select trigger fits.
 */
export function ValidatedField({
  id,
  label,
  description,
  error,
  thread,
  className,
  children,
}: Readonly<{
  id: string;
  label: ReactNode;
  description?: ReactNode;
  error?: string | undefined;
  thread?: FieldThread;
  className?: string;
  children: (control: ValidatedControlProps) => ReactNode;
}>) {
  const descriptionId =
    description === undefined ? undefined : `${id}-description`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy =
    [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <Field
      data-invalid={error === undefined ? undefined : true}
      className={cn(className)}
    >
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <FieldControl state={thread}>
        {children({
          id,
          'aria-invalid': error !== undefined,
          'aria-describedby': describedBy,
        })}
      </FieldControl>
      {description === undefined ? null : (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
      {error === undefined ? null : (
        <FieldError id={errorId}>{error}</FieldError>
      )}
    </Field>
  );
}
