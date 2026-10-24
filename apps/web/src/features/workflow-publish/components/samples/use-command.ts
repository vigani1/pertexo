import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { StepSampleMetadata, StepSampleSource } from '@pertexo/contracts';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import {
  changeStepSample,
  type SampleCommand,
  type SampleScope,
} from '../../data/samples/api';
import { sampleErrorDetail } from '../../model/testing/samples';
import { stepSamplesKey } from '../../data/samples/queries';
export function useSampleCommand(
  scope: SampleScope,
  nodeId: string,
  ensureSaved: () => Promise<Readonly<{ revision: number }>>,
  onSuccess?: () => void,
) {
  const client = useQueryClient();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, []);
  const command = useRetainedCommand<SampleCommand, unknown>(
    async (body, key) => {
      const controller = lifetime.current;
      if (controller === undefined || controller.signal.aborted)
        throw new DOMException('Aborted', 'AbortError');
      try {
        return await changeStepSample({
          scope,
          nodeId,
          command: body,
          key,
          signal: controller.signal,
        });
      } catch (cause) {
        if (isApiError(cause) && (cause.status === 409 || cause.status === 412))
          await client.invalidateQueries({ queryKey: stepSamplesKey(scope) });
        throw cause;
      }
    },
    async () => {
      await client.invalidateQueries({ queryKey: stepSamplesKey(scope) });
      if (lifetime.current?.signal.aborted === false) onSuccess?.();
    },
    { action: 'saving the pinned sample' },
  );
  async function save(
    source: StepSampleSource | 'remove',
    sample: StepSampleMetadata | null,
  ) {
    if (preparing || command.pending || command.uncertain) return;
    const controller = lifetime.current;
    if (controller === undefined || controller.signal.aborted) return;
    const isCurrent = () => !controller.signal.aborted;
    setPreparing(true);
    setError(undefined);
    try {
      const { revision } = await ensureSaved();
      if (!isCurrent()) return;
      if (source === 'remove') {
        if (sample === null) return;
        await command.send({
          kind: 'remove',
          body: {
            expectedDraftRevision: revision,
            expectedSampleId: sample.id,
          },
        });
      } else
        await command.send({
          kind: 'put',
          body: {
            expectedDraftRevision: revision,
            expectedSampleId: sample?.id ?? null,
            source,
          },
        });
    } catch (cause) {
      if (isCurrent())
        setError(
          describeCommandError(cause, 'saving the draft before pinning'),
        );
    } finally {
      if (isCurrent()) setPreparing(false);
    }
  }
  return {
    ...command,
    pending: preparing || command.pending,
    error:
      error ??
      (command.uncertain
        ? command.error
        : (sampleErrorDetail(command.cause) ?? command.error)),
    save,
  };
}
