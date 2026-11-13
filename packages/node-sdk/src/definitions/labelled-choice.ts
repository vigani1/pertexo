import { z } from 'zod';

/**
 * A choice whose stored values are IDs, each with the words people read.
 * The projection stays standard JSON Schema: `enum` keeps the stored
 * values, and a `oneOf` of `{ const, title }` names each one, so an editor
 * can draw a labelled select without a table of its own. The labels and
 * the values come from one record, so they can't drift apart.
 */
export function labelledChoice<const Value extends string>(
  labels: Readonly<Record<Value, string>>,
) {
  const values = Object.keys(labels) as [Value, ...Value[]];
  return z.enum(values).meta({
    oneOf: values.map((value) => ({ const: value, title: labels[value] })),
  });
}
