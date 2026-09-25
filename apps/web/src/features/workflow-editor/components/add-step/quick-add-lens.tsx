import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import {
  useDeferredValue,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { FieldLabel } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTitle } from '@/components/ui/popover';
import { useEditorStore } from '../../model/editor-store-context';
import { stepTitle } from '../../model/graph-adapter';
import { followingSteps } from '../../model/quick-add';
import type { QuickAddRequest } from '../../use-quick-add';
import { ChoiceSelect } from '../inspector/choice-select';
import { StepChoiceList, StepSearch } from './step-picker';

/**
 * Quick add: the add-step search and list in a lens at the drop point (or
 * beside the step for “Add step after”). Choosing a step adds it there,
 * connected from the chosen output. Escape or a click away closes it.
 */
export function QuickAddLens({
  request,
  definitions,
  fallbackFocus,
  onPortChange,
  onChoose,
  onClose,
}: Readonly<{
  request: QuickAddRequest | undefined;
  definitions: readonly NodeDefinitionCatalogItem[];
  /** Where focus goes afterwards when the opener is gone. */
  fallbackFocus: RefObject<HTMLElement | null>;
  onPortChange: (port: string) => void;
  onChoose: (definition: NodeDefinitionCatalogItem) => void;
  onClose: () => void;
}>) {
  return (
    <Popover
      open={request !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {request === undefined ? null : (
        <QuickAddContent
          request={request}
          definitions={definitions}
          fallbackFocus={fallbackFocus}
          onPortChange={onPortChange}
          onChoose={onChoose}
        />
      )}
    </Popover>
  );
}

function QuickAddContent({
  request,
  definitions,
  fallbackFocus,
  onPortChange,
  onChoose,
}: Readonly<{
  request: QuickAddRequest;
  definitions: readonly NodeDefinitionCatalogItem[];
  fallbackFocus: RefObject<HTMLElement | null>;
  onPortChange: (port: string) => void;
  onChoose: (definition: NodeDefinitionCatalogItem) => void;
}>) {
  const searchRef = useRef<HTMLInputElement>(null);
  const portId = useId();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const { anchor, returnFocus } = request;
  // A stable reference, so positioning doesn't restart on every render.
  const virtualAnchor = useMemo(() => pointAnchor(anchor), [anchor]);
  const sourceTitle = useEditorStore((state) => {
    const source = state.graph.nodes.find(
      (node) => node.id === request.from.nodeId,
    );
    return source === undefined ? 'this step' : stepTitle(source);
  });
  return (
    <PopoverContent
      anchor={virtualAnchor}
      side="right"
      align="center"
      initialFocus={searchRef}
      finalFocus={() =>
        returnFocus?.isConnected === true ? returnFocus : fallbackFocus.current
      }
      className="flex max-h-[min(28rem,var(--available-height))] w-72 flex-col gap-3 p-3"
    >
      <PopoverTitle className="truncate text-sm">
        Add a step after “{sourceTitle}”
      </PopoverTitle>
      {request.outputs.length > 1 ? (
        <div className="flex items-center gap-2">
          <FieldLabel htmlFor={portId} className="shrink-0">
            Connect from
          </FieldLabel>
          <ChoiceSelect
            id={portId}
            value={request.from.port}
            disabled={false}
            choices={request.outputs.map((port) => ({
              value: port,
              label: port,
            }))}
            onChange={(port) => {
              if (port !== null) onPortChange(port);
            }}
          />
        </div>
      ) : null}
      <StepSearch
        query={query}
        onQueryChange={setQuery}
        inputRef={searchRef}
        className="flex-none"
      />
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <StepChoiceList
          definitions={followingSteps(definitions)}
          query={deferredQuery}
          onPick={(choice) => {
            onChoose(choice.definition);
          }}
        />
      </div>
    </PopoverContent>
  );
}

/** A zero-size anchor at a viewport point, for the popup to sit beside. */
function pointAnchor(point: Readonly<{ x: number; y: number }>) {
  const rect = {
    x: point.x,
    y: point.y,
    top: point.y,
    left: point.x,
    right: point.x,
    bottom: point.y,
    width: 0,
    height: 0,
  };
  return { getBoundingClientRect: () => rect };
}
