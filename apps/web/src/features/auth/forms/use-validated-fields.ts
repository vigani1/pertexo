import { useRef, useState, type ChangeEvent } from 'react';
import type { FieldThreadState } from '@/components/patterns/text-field';

type Values<Name extends string> = Readonly<Record<Name, string>>;

/** Returns the sentence to show under the field, or undefined when valid. */
export type FieldRule<Name extends string> = (
  value: string,
  values: Values<Name>,
) => string | undefined;

export type FieldRules<Name extends string> = Readonly<
  Record<Name, FieldRule<Name>>
>;

export type { FieldThreadState };

/**
 * Local input feedback for one form: fields are checked when people leave
 * them, then live while they correct them (and everywhere after a failed
 * submit). A field that goes from invalid to valid briefly ties a knot.
 * The server stays authoritative; this only improves the feedback.
 */
export function useValidatedFields<Name extends string>(
  rules: FieldRules<Name>,
  initial: Values<Name>,
) {
  const names = Object.keys(rules) as Name[];
  const [values, setValues] = useState<Values<Name>>(initial);
  const [errors, setErrors] = useState<Partial<Record<Name, string>>>({});
  const [corrected, setCorrected] = useState<Partial<Record<Name, true>>>({});
  const [submitted, setSubmitted] = useState(false);
  const elements = useRef<Partial<Record<Name, HTMLInputElement | null>>>({});
  // The newest input, even if a submit arrives before the next render.
  const latest = useRef<Values<Name>>(initial);

  function apply(checked: readonly Name[], nextValues: Values<Name>) {
    const nextErrors: Partial<Record<Name, string>> = {};
    const nextCorrected: Partial<Record<Name, true>> = {};
    for (const name of names) {
      const message = checked.includes(name)
        ? rules[name](nextValues[name], nextValues)
        : errors[name];
      const wasCorrected = checked.includes(name)
        ? message === undefined &&
          (errors[name] !== undefined || corrected[name] === true)
        : corrected[name] === true;
      if (message !== undefined) nextErrors[name] = message;
      else if (wasCorrected) nextCorrected[name] = true;
    }
    setErrors(nextErrors);
    setCorrected(nextCorrected);
    return nextErrors;
  }

  function change(name: Name, value: string) {
    const nextValues = { ...latest.current, [name]: value };
    latest.current = nextValues;
    setValues(nextValues);
    // Other fields showing an error may depend on this one (confirmations).
    const live = names.filter(
      (candidate) =>
        errors[candidate] !== undefined || (candidate === name && submitted),
    );
    if (live.length > 0) apply(live, nextValues);
  }

  /**
   * Checks every field. Returns the values to submit when all are valid;
   * otherwise focuses the first invalid field and returns undefined.
   */
  function validateAll(): Values<Name> | undefined {
    setSubmitted(true);
    const submittedValues = latest.current;
    const nextErrors = apply(names, submittedValues);
    const firstInvalid = names.find((name) => nextErrors[name] !== undefined);
    if (firstInvalid === undefined) return submittedValues;
    elements.current[firstInvalid]?.focus();
    return undefined;
  }

  function reset(nextValues: Values<Name> = initial) {
    latest.current = nextValues;
    setValues(nextValues);
    setErrors({});
    setCorrected({});
    setSubmitted(false);
  }

  function threadState(name: Name): FieldThreadState {
    if (errors[name] !== undefined) return 'invalid';
    return corrected[name] === true ? 'corrected' : undefined;
  }

  /** Props for the field's input: value, handlers, ref and aria-invalid. */
  function inputProps(name: Name) {
    return {
      ref: (element: HTMLInputElement | null) => {
        elements.current[name] = element;
      },
      value: values[name],
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        change(name, event.target.value);
      },
      onBlur: () => {
        apply([name], latest.current);
      },
      'aria-invalid': errors[name] === undefined ? undefined : true,
    } as const;
  }

  return {
    values,
    errors,
    inputProps,
    threadState,
    validateAll,
    reset,
    setValue: change,
    focus: (name: Name) => elements.current[name]?.focus(),
  };
}

export type ValidatedFields<Name extends string> = ReturnType<
  typeof useValidatedFields<Name>
>;
