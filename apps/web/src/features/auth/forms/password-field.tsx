import { useState, type ComponentProps, type ReactNode } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordMeter } from './password-meter';

type PasswordFieldProps = Readonly<{
  id: string;
  label: ReactNode;
  labelAction?: ReactNode;
  error?: string | undefined;
  /** Shows the requirement thread for a new password. */
  minimumLength?: number | undefined;
}> &
  Omit<ComponentProps<typeof Input>, 'id' | 'type' | 'children'>;

/** A password input with show/hide and, for new passwords, the meter. */
export function PasswordField({
  id,
  label,
  labelAction,
  error,
  minimumLength,
  ...inputProps
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const meterId = `${id}-meter`;
  const { value } = inputProps;
  return (
    <LabelledField
      id={id}
      label={label}
      labelAction={labelAction}
      error={error}
      describedBy={minimumLength === undefined ? undefined : meterId}
      trailing={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => {
            setVisible((current) => !current);
          }}
        >
          {visible ? (
            <EyeOffIcon aria-hidden="true" />
          ) : (
            <EyeIcon aria-hidden="true" />
          )}
        </Button>
      }
      feedback={
        minimumLength === undefined ? undefined : (
          <PasswordMeter
            id={meterId}
            length={typeof value === 'string' ? value.length : 0}
            minimumLength={minimumLength}
          />
        )
      }
    >
      {(control) => (
        <Input
          {...control}
          type={visible ? 'text' : 'password'}
          maxLength={128}
          {...inputProps}
        />
      )}
    </LabelledField>
  );
}
