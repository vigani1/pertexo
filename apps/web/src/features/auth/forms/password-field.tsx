import { useState } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordMeter } from './password-meter';
import {
  TextField,
  type TextFieldProps,
} from '@/components/patterns/text-field';

type PasswordFieldProps = Omit<TextFieldProps, 'type' | 'trailing'> &
  Readonly<{
    /** Shows the requirement thread for a new password. */
    minimumLength?: number | undefined;
  }>;

/** A password input with show/hide and, for new passwords, the meter. */
export function PasswordField({
  id,
  minimumLength,
  value,
  children,
  ...props
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const meterId = `${id}-meter`;
  const length = typeof value === 'string' ? value.length : 0;
  return (
    <TextField
      id={id}
      type={visible ? 'text' : 'password'}
      value={value}
      maxLength={128}
      {...(minimumLength === undefined ? {} : { 'aria-describedby': meterId })}
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
      {...props}
    >
      {minimumLength === undefined ? null : (
        <PasswordMeter
          id={meterId}
          length={length}
          minimumLength={minimumLength}
        />
      )}
      {children}
    </TextField>
  );
}
