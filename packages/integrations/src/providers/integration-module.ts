import type { ConnectionDefinition } from './connection-definition.js';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import type { NodeCatalog } from '@pertexo/node-sdk';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';

export type IntegrationPresentation = NonNullable<
  NodeDefinitionCatalogItem['presentation']
>;

export interface IntegrationModule {
  readonly key: string;
  readonly presentation: IntegrationPresentation;
  readonly steps: readonly Readonly<{
    registration: NodeDefinitionRegistration;
    presentation?: Partial<IntegrationPresentation>;
  }>[];
  readonly connections?: readonly ConnectionDefinition[];
  readonly policies?: NodeCatalog['policies'];
}
