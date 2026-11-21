import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NodeDefinitionListResponse } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { authoringCatalogQueryOptions } from '../data/catalog.queries';
import { StepDescriptionsContext } from '../hooks/step-descriptions';
import {
  catalogStepDescriptions,
  describeStep,
} from '../model/steps/presentation';

function selectStepDescriptions(
  catalog: Readonly<{ definitions: NodeDefinitionListResponse }>,
) {
  return catalogStepDescriptions(catalog.definitions.items);
}

export function CatalogStepDescriptions({
  apiClient,
  userId,
  children,
}: Readonly<{ apiClient: ApiClient; userId: string; children: ReactNode }>) {
  const { data } = useQuery({
    ...authoringCatalogQueryOptions(apiClient, userId),
    select: selectStepDescriptions,
  });
  return (
    <StepDescriptionsContext value={data ?? describeStep}>
      {children}
    </StepDescriptionsContext>
  );
}
