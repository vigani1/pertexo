import type { NodeDefinitionListResponse } from '@pertexo/contracts';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { ApiClient } from '@/lib/api/client';
import { authoringCatalogQueryOptions } from '../data/catalog.queries';
import { ConnectionDefinitions } from './connection-definitions';
import { StepDescriptionsContext } from '../hooks/step-descriptions';
import {
  catalogStepDescriptions,
  describeStep,
} from '../model/steps/presentation';

function selectCatalogPresentation(
  catalog: Readonly<{ definitions: NodeDefinitionListResponse }>,
) {
  return {
    describe: catalogStepDescriptions(catalog.definitions.items),
    credentials: catalog.definitions.connections,
  };
}

export function CatalogStepDescriptions({
  apiClient,
  userId,
  children,
}: Readonly<{ apiClient: ApiClient; userId: string; children: ReactNode }>) {
  const { data } = useQuery({
    ...authoringCatalogQueryOptions(apiClient, userId),
    select: selectCatalogPresentation,
  });
  return (
    <StepDescriptionsContext value={data?.describe ?? describeStep}>
      <ConnectionDefinitions items={data?.credentials}>
        {children}
      </ConnectionDefinitions>
    </StepDescriptionsContext>
  );
}
