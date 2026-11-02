import { expect } from 'vitest';

import type { World } from './world.js';

type Items = Readonly<{ items: readonly Readonly<{ id: string }>[] }>;

export const root = ({ workspaceId }: World) => `/v1/workspaces/${workspaceId}`;
export const workflow = (world: World) =>
  `${root(world)}/workflows/${world.workflowId}`;

export const lists =
  (select: (world: World) => string) => (body: Items, world: World) => {
    expect(body.items.map(({ id }) => id)).toContain(select(world));
  };
