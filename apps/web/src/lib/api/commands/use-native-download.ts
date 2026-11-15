import { useState } from 'react';
import { describeCommandError } from '@/lib/api/error-copy';

/**
 * Starts a download the browser itself saves. Only the start can fail here;
 * a refused start reads as `error`, phrased by what was being started.
 */
export function useNativeDownload<Input>(
  start: (input: Input) => void,
  action: string,
) {
  const [error, setError] = useState<string>();
  return {
    error,
    start(input: Input) {
      setError(undefined);
      try {
        start(input);
      } catch (cause) {
        setError(describeCommandError(cause, action));
      }
    },
  };
}
