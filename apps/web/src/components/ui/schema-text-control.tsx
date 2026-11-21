import type { ComponentPropsWithRef } from 'react';
import { Input } from './input';
import { Textarea } from './textarea';

type InputProps = ComponentPropsWithRef<typeof Input>;
type TextareaProps = ComponentPropsWithRef<typeof Textarea>;
type SharedProps = Pick<
  TextareaProps,
  | 'id'
  | 'name'
  | 'autoComplete'
  | 'className'
  | 'value'
  | 'disabled'
  | 'aria-invalid'
  | 'aria-describedby'
>;
type ControlProps =
  | (Omit<InputProps, 'onChange'> & Readonly<{ multiline?: false }>)
  | (Omit<TextareaProps, 'onChange'> & Readonly<{ multiline: true }>)
  | (SharedProps & Readonly<{ multiline: boolean; onBlur: () => void }>);

export function SchemaTextControl({
  onTextChange,
  ...props
}: ControlProps & Readonly<{ onTextChange: (text: string) => void }>) {
  if (props.multiline === true) {
    const { multiline: _multiline, ...control } = props;
    return (
      <Textarea
        {...control}
        onChange={(event) => {
          onTextChange(event.currentTarget.value);
        }}
      />
    );
  }
  const { multiline: _multiline, ...control } = props;
  return (
    <Input
      {...control}
      onChange={(event) => {
        onTextChange(event.currentTarget.value);
      }}
    />
  );
}
