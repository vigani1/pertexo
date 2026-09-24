import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type RefCallback,
} from 'react';
import type { FieldThread } from './field';

/** Field name → message; an undefined message means the field is valid. */
export type FieldErrors<Name extends string> = Readonly<
  Partial<Record<Name, string | undefined>>
>;

export type FieldValidation<Name extends string> = Readonly<{
  error: (name: Name) => string | undefined;
  thread: (name: Name) => FieldThread;
  /** Ref for the control that receives focus when its field is invalid. */
  register: (name: Name) => RefCallback<HTMLElement>;
  /** Leaving a field shows (or clears) its message. */
  blur: (name: Name, message: string | undefined) => void;
  /** Typing re-checks live once the field shows a message or after a submit. */
  change: (name: Name, message: string | undefined) => void;
  /** Shows every message and focuses the first invalid control. */
  submit: (errors: FieldErrors<Name>) => boolean;
  /** Places server-reported field messages (`errors[].path`) and focuses the first. */
  showErrors: (errors: FieldErrors<Name>) => void;
  reset: () => void;
}>;

type Messages<Name extends string> = ReadonlyMap<Name, string>;

function toMessages<Name extends string>(
  errors: FieldErrors<Name>,
): Messages<Name> {
  const messages = new Map<Name, string>();
  for (const name in errors) {
    const message = errors[name];
    if (message !== undefined) messages.set(name, message);
  }
  return messages;
}

function withMessage<Name extends string>(
  messages: Messages<Name>,
  name: Name,
  message: string | undefined,
): Messages<Name> {
  if (messages.get(name) === message) return messages;
  const next = new Map(messages);
  if (message === undefined) next.delete(name);
  else next.set(name, message);
  return next;
}

function withCorrected<Name extends string>(
  corrected: ReadonlySet<Name>,
  name: Name,
  recovered: boolean,
): ReadonlySet<Name> {
  if (recovered === corrected.has(name)) return corrected;
  const next = new Set(corrected);
  if (recovered) next.add(name);
  else next.delete(name);
  return next;
}

/**
 * Weft's one validation timing, for every form. A field is checked when
 * people leave it, then live while they correct it (or everywhere after a
 * failed submit); a submit focuses the first invalid control in document
 * order; server field errors land on the same fields; and a field that goes
 * from invalid to valid ties a brief knot. The caller owns values and rules —
 * this owns only which messages show and when.
 */
export function useFieldValidation<
  Name extends string,
>(): FieldValidation<Name> {
  const [messages, setMessages] = useState<Messages<Name>>(() => new Map());
  const [corrected, setCorrected] = useState<ReadonlySet<Name>>(
    () => new Set(),
  );
  const [submitted, setSubmitted] = useState(false);
  const controls = useRef(new Map<Name, HTMLElement>());
  const refs = useRef(new Map<Name, RefCallback<HTMLElement>>());

  return useMemo<FieldValidation<Name>>(() => {
    function focusFirst(next: Messages<Name>) {
      const invalid = [...controls.current.entries()]
        .filter(([name]) => next.has(name))
        .map(([, element]) => element)
        .sort((left, right) =>
          left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
        );
      invalid[0]?.focus();
    }

    function show(name: Name, message: string | undefined) {
      // The knot stays tied until the field frays again or the form resets.
      if (message === undefined && messages.has(name))
        setCorrected((current) => withCorrected(current, name, true));
      if (message !== undefined)
        setCorrected((current) => withCorrected(current, name, false));
      setMessages((current) => withMessage(current, name, message));
    }

    function place(errors: FieldErrors<Name>) {
      const next = toMessages(errors);
      setMessages(next);
      setCorrected((current) => {
        const kept = new Set(current);
        for (const name of next.keys()) kept.delete(name);
        for (const name of messages.keys()) if (!next.has(name)) kept.add(name);
        return kept;
      });
      return next;
    }

    return {
      error: (name) => messages.get(name),
      thread: (name) => {
        if (messages.has(name)) return 'invalid';
        return corrected.has(name) ? 'corrected' : undefined;
      },
      register: (name) => {
        const existing = refs.current.get(name);
        if (existing !== undefined) return existing;
        const ref: RefCallback<HTMLElement> = (element) => {
          if (element === null) controls.current.delete(name);
          else controls.current.set(name, element);
        };
        refs.current.set(name, ref);
        return ref;
      },
      blur: show,
      change: (name, message) => {
        if (submitted || messages.has(name)) show(name, message);
      },
      submit: (errors) => {
        setSubmitted(true);
        const next = place(errors);
        if (next.size === 0) return true;
        focusFirst(next);
        return false;
      },
      showErrors: (errors) => {
        const next = place(errors);
        // The fields may only appear with the next render (another step).
        queueMicrotask(() => {
          focusFirst(next);
        });
      },
      reset: () => {
        setMessages(new Map());
        setCorrected(new Set());
        setSubmitted(false);
      },
    };
  }, [corrected, messages, submitted]);
}

type Values<Name extends string> = Readonly<Record<Name, string>>;

/** The sentence to show under a field, or undefined when it is valid. */
export type FieldRule<Name extends string> = (
  value: string,
  values: Values<Name>,
) => string | undefined;

/**
 * A thin convenience over `useFieldValidation` for forms of plain text
 * values checked by rules. It owns the values; the timing stays the
 * engine's. A change re-checks the field and any field already showing a
 * message, so a confirmation follows the password it repeats.
 */
export function useFieldValues<Name extends string>(
  rules: Readonly<Record<Name, FieldRule<Name>>>,
  initial: Values<Name>,
) {
  const validation = useFieldValidation<Name>();
  const [values, setValues] = useState<Values<Name>>(initial);
  // The newest input, even if a submit arrives before the next render.
  const latest = useRef<Values<Name>>(initial);
  const names = Object.keys(rules) as Name[];
  const check = (name: Name, next: Values<Name>) =>
    rules[name](next[name], next);

  function setValue(name: Name, value: string) {
    const next = { ...latest.current, [name]: value };
    latest.current = next;
    setValues(next);
    for (const candidate of names)
      if (candidate === name || validation.error(candidate) !== undefined)
        validation.change(candidate, check(candidate, next));
  }

  return {
    values,
    error: validation.error,
    thread: validation.thread,
    /** The message and thread for a `LabelledField`. */
    field: (name: Name) => ({
      error: validation.error(name),
      thread: validation.thread(name),
    }),
    showErrors: validation.showErrors,
    setValue,
    /** Every rule checked: the values to send, or undefined after focusing a problem. */
    validate: (): Values<Name> | undefined => {
      const current = latest.current;
      const errors: Partial<Record<Name, string | undefined>> = {};
      for (const name of names) errors[name] = check(name, current);
      return validation.submit(errors) ? current : undefined;
    },
    reset: (next: Values<Name> = initial) => {
      latest.current = next;
      setValues(next);
      validation.reset();
    },
    /** Value, change, blur and focus wiring for the field's text control. */
    control: (name: Name) => ({
      ref: validation.register(name),
      value: values[name],
      onChange: (
        event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => {
        setValue(name, event.target.value);
      },
      onBlur: () => {
        validation.blur(name, check(name, latest.current));
      },
    }),
  };
}
