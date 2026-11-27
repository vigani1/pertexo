import { SheetFooter } from '@/components/ui/sheet';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { stepSampleSourceSchema } from '@pertexo/contracts';
import type { SampleDialogSource } from '../../model/step-samples';
import { SampleContent } from './content';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { SampleScope } from '../../data/samples/step-samples.api';
import { stepSampleQueryOptions } from '../../data/samples/step-samples.queries';
import { useSampleCommand } from '../../data/samples/step-sample.mutations';
export function PinSampleDialog({
  scope,
  nodeId,
  source,
  ensureSaved,
  onClose,
}: Readonly<{
  scope: SampleScope;
  nodeId: string;
  source: SampleDialogSource;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  onClose: () => void;
}>) {
  const query = useQuery(stepSampleQueryOptions(scope, nodeId));
  const [text, setText] = useState('{}');
  const [parseError, setParseError] = useState<string>();
  const command = useSampleCommand(scope, nodeId, ensureSaved, onClose);
  const locked = command.pending || command.uncertain;
  async function save() {
    if (query.isError || query.data === undefined || source === 'view') return;
    setParseError(undefined);
    if (source !== 'paste') {
      await command.save(source, query.data.sample);
      return;
    }
    try {
      const value: unknown = JSON.parse(text);
      await command.save(
        stepSampleSourceSchema.parse({ kind: 'json', value }),
        query.data.sample,
      );
    } catch {
      setParseError(
        'Enter valid JSON within the size and depth limits, like {"amount": 1240}.',
      );
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && (!locked || command.expired)) onClose();
      }}
    >
      <SheetContent variant="form" className="flex flex-col gap-4">
        <div>
          <SheetTitle>
            {source === 'view' ? 'Pinned output' : 'Pin sample output'}
          </SheetTitle>
          <SheetDescription>
            Shared with people who can see run data. Editor tests use this
            output without calling the step. Published runs always run for real.
          </SheetDescription>
        </div>
        <SampleContent
          query={query}
          source={source}
          text={text}
          onTextChange={setText}
          locked={locked}
        />
        {parseError === undefined && command.error === undefined ? null : (
          <Notice tone="destructive">{parseError ?? command.error}</Notice>
        )}
        <SheetFooter>
          <Button
            variant="outline"
            disabled={locked && !command.expired}
            onClick={onClose}
          >
            Close
          </Button>
          {command.uncertain ? (
            <Button
              disabled={command.pending || command.expired}
              onClick={command.retry}
            >
              Retry the same pin
            </Button>
          ) : null}
          {!command.uncertain && source !== 'view' ? (
            <ProgressButton
              pending={command.pending}
              pendingLabel="Pinning…"
              disabled={query.isError || query.data === undefined}
              onClick={() => void save()}
            >
              Pin output
            </ProgressButton>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
