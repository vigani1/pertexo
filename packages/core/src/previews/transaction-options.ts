export function optionsFor(signal: AbortSignal | undefined): {
  signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}
