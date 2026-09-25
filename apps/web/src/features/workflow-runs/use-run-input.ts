import { useState } from 'react';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import {
  runDeadlineProblem,
  runInputProblem,
  toRunIntent,
  type RunInputField,
  type RunIntent,
} from './model/run-intent';

/**
 * The input and optional deadline for a new run (from Build or a replay):
 * the text people type, its validation and the intent it becomes.
 */
export function useRunInput() {
  const [input, setInput] = useState('{}');
  const [deadline, setDeadline] = useState('');
  const validation = useFieldValidation<RunInputField>();

  return {
    input,
    deadline,
    validation,
    changeInput: (text: string) => {
      setInput(text);
      validation.change('input', runInputProblem(text));
    },
    changeDeadline: (text: string) => {
      setDeadline(text);
      validation.change('deadline', runDeadlineProblem(text));
    },
    blurInput: () => {
      validation.blur('input', runInputProblem(input));
    },
    /** Pass the text the field settled on when it differs from state. */
    blurDeadline: (settled: string = deadline) => {
      validation.blur('deadline', runDeadlineProblem(settled));
    },
    /** The intent to send, or undefined after focusing the first problem. */
    read: (): RunIntent | undefined =>
      validation.submit({
        input: runInputProblem(input),
        deadline: runDeadlineProblem(deadline),
      })
        ? toRunIntent(input, deadline)
        : undefined,
    reset: () => {
      setInput('{}');
      setDeadline('');
      validation.reset();
    },
  };
}

export type RunInput = ReturnType<typeof useRunInput>;
