import { useMemo, useRef, useState } from 'react';

/** Field name → message; an undefined message means the field is valid. */
export type FieldErrors<Name extends string> = Readonly<
  Partial<Record<Name, string | undefined>>
>;

/** What `FieldControl` draws under a control: a fray, a brief knot or nothing. */
export type FieldThread = 'invalid' | 'corrected' | undefined;

export type FieldValidation<Name extends string> = Readonly<{
  error: (name: Name) => string | undefined;
  thread: (name: Name) => FieldThread;
  /** Ref for the control that receives focus when its field is invalid. */
  register: (name: Name) => (element: HTMLElement | null) => void;
  /** Leaving a field shows (or clears) its message. */
  blur: (name: Name, message: string | undefined) => void;
  /** Typing re-checks live once the field shows a message or after a submit. */
  change: (name: Name, message: string | undefined) => void;
  /** Shows every message and focuses the first invalid control. */
  submit: (errors: FieldErrors<Name>) => boolean;
  /** Places server-reported field messages and focuses the first one. */
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

/**
 * Weft's validation timing for one form. Fields are checked when people leave
 * them, then live while they correct them (or everywhere after a failed
 * submit); a submit focuses the first invalid control in document order. The
 * caller owns the values and rules — this only owns which messages show.
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
  const refs = useRef(new Map<Name, (element: HTMLElement | null) => void>());

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
      const recovered = message === undefined && messages.has(name);
      setMessages((current) => withMessage(current, name, message));
      setCorrected((previous) => {
        if (recovered === previous.has(name)) return previous;
        const next = new Set(previous);
        if (recovered) next.add(name);
        else next.delete(name);
        return next;
      });
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
        const ref = (element: HTMLElement | null) => {
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
        const next = toMessages(errors);
        setSubmitted(true);
        setMessages(next);
        setCorrected(new Set());
        if (next.size === 0) return true;
        focusFirst(next);
        return false;
      },
      showErrors: (errors) => {
        const next = toMessages(errors);
        setMessages(next);
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
