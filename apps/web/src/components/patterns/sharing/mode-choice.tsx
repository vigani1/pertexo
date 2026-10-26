import { LockIcon, UsersIcon } from 'lucide-react';
import { ChoiceCards } from '../choice-cards';

type Mode = 'workspace' | 'restricted';

/** Everyone in the workspace, or only the people listed below. */
export function SharingModeChoice({
  legend,
  value,
  everyone,
  restricted,
  disabled,
  onChange,
}: Readonly<{
  legend: string;
  value: Mode;
  everyone: Readonly<{ label: string; hint: string }>;
  restricted: Readonly<{ label: string; hint: string }>;
  disabled: boolean;
  onChange: (mode: Mode) => void;
}>) {
  return (
    <ChoiceCards
      legend={legend}
      value={value}
      disabled={disabled}
      onChange={onChange}
      choices={[
        {
          value: 'workspace',
          glyph: <UsersIcon className="size-3.5" />,
          ...everyone,
        },
        {
          value: 'restricted',
          glyph: <LockIcon className="size-3.5" />,
          ...restricted,
        },
      ]}
    />
  );
}
