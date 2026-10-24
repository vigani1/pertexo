import { QueryView } from '@/components/patterns/states/query-view';
import { useEffect, useEffectEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { Button } from '@/components/ui/button';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  templateUnavailableReasons,
  type CuratedTemplate,
} from '../../model/templates/curated-setup';
import { PatternGlyph } from '../pattern-glyph';
import { Disclosure } from '@/components/ui/disclosure';

/**
 * Ready-made workflows, each drawn as its own thread: one line on what it
 * does, and what it takes and touches folded under Details. `initialId` is
 * chosen once this workspace's catalog shows it can be built; otherwise its
 * reasons show and nothing is chosen.
 */
export function CuratedTemplateChoice({
  apiClient,
  userId,
  disabled,
  selectedId,
  initialId,
  onChoose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  disabled: boolean;
  selectedId: string | undefined;
  initialId?: string | undefined;
  onChoose: (template: CuratedTemplate) => void;
}>) {
  const catalog = useQuery({
    ...authoringCatalogQueryOptions(apiClient, userId),
    staleTime: 0,
  });
  const chooseInitial = useEffectEvent((template: CuratedTemplate) => {
    onChoose(template);
  });
  const definitions =
    catalog.isFetching || catalog.isError
      ? undefined
      : catalog.data?.definitions;
  useEffect(() => {
    if (initialId === undefined || definitions === undefined || disabled)
      return;
    const initial = CURATED_WORKFLOW_TEMPLATES.find(
      (template) => template.templateId === initialId,
    );
    if (
      initial !== undefined &&
      templateUnavailableReasons(initial, definitions).length === 0
    )
      chooseInitial(initial);
  }, [definitions, disabled, initialId]);
  return (
    <section
      aria-label="Curated workflow examples"
      className="flex flex-col gap-2"
    >
      <QueryView query={catalog} resource="The step catalog" loading={null} />
      {CURATED_WORKFLOW_TEMPLATES.map((template) => {
        const reasons = templateUnavailableReasons(
          template,
          catalog.isError ? undefined : catalog.data?.definitions,
        );
        const selected = template.templateId === selectedId;
        const unavailable =
          disabled || catalog.isFetching || reasons.length > 0;
        return (
          <article
            key={template.templateId}
            aria-label={template.title}
            className={cn(
              'grid grid-cols-1 items-center gap-x-3 gap-y-2 rounded-lg border p-2.5 transition-colors motion-reduce:transition-none sm:grid-cols-[8.25rem_minmax(0,1fr)]',
              selected
                ? 'border-primary/45 bg-primary/[0.06]'
                : 'border-border bg-surface-ink/[0.02] hover:border-border-strong',
            )}
          >
            <span
              aria-hidden="true"
              className="grid place-items-center self-start rounded-md bg-recess-ink/25 py-2 sm:row-span-2"
            >
              <PatternGlyph graph={template.manifest.graph} />
            </span>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">
                  {template.title}
                </h3>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {template.description}
                </p>
              </div>
              <Button
                variant={selected ? 'default' : 'outline'}
                size="sm"
                aria-label={`Set up ${template.title}`}
                aria-pressed={selected}
                disabled={unavailable}
                className="shrink-0"
                onClick={() => {
                  onChoose(template);
                }}
              >
                {selected ? 'Chosen' : 'Use'}
              </Button>
            </div>
            <div className="flex min-w-0 flex-col gap-1 sm:col-start-2">
              {reasons.map((reason) => (
                <p key={reason} className="text-xs text-warning">
                  {reason}
                </p>
              ))}
              <Disclosure
                summary="Details"
                className="text-xs text-muted-foreground"
                appearance={{ size: 'xs' }}
              >
                <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <dt className="text-subtle-foreground">Input</dt>
                  <dd>{template.inputSummary}</dd>
                  <dt className="text-subtle-foreground">Limits</dt>
                  <dd>{template.boundsSummary}</dd>
                  <dt className="text-subtle-foreground">Effects</dt>
                  <dd>{template.effectsSummary}</dd>
                </dl>
              </Disclosure>
            </div>
          </article>
        );
      })}
    </section>
  );
}
