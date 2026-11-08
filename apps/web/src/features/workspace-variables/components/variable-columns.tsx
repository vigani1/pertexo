/** Column names over the variable rows on wider screens. */
export function VariableColumns() {
  return (
    <div
      aria-hidden="true"
      className="hidden grid-cols-[minmax(8rem,15rem)_minmax(0,1fr)_auto] gap-x-4 border-b border-border pb-2 font-mono text-[0.68rem] text-subtle-foreground sm:grid"
    >
      <span>Name</span>
      <span>Value</span>
      <span />
    </div>
  );
}
