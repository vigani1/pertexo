/**
 * The sentence under the Loom. With the exact window total it says how many
 * runs the window holds and, when the drawing stops at its cap, that only the
 * latest are drawn. Without the total, a capped drawing still says so.
 */
export function loomCaption({
  phrase,
  capped,
  total,
}: Readonly<{
  /** For example "the last hour". */
  phrase: string;
  /** The Loom drew only the latest 300 runs created in the window. */
  capped: boolean;
  total: number | undefined;
}>): string | undefined {
  if (total === undefined)
    return capped
      ? `Showing the latest 300 runs in ${phrase}. Narrow the window to see every run.`
      : undefined;
  const runs = `${String(total)} ${total === 1 ? 'run' : 'runs'} in ${phrase}`;
  return capped
    ? `${runs}. The Loom draws the latest 300; narrow the window to see every run.`
    : `${runs}.`;
}
