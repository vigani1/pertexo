import type { Closeable, OwnedResource } from './contract.js';

export function createLifecycleResourceOwners(resources: OwnedResource[]) {
  const registerResource = <Resource extends object>(
    label: string,
    resource: Resource,
    close: (resource: Resource) => unknown,
  ): Resource => {
    let resourceClosePromise: Promise<void> | undefined;
    resources.push({
      label,
      resource,
      close: () => {
        resourceClosePromise ??= Promise.resolve()
          .then(() => close(resource))
          .then(() => undefined);
        return resourceClosePromise;
      },
    });
    return resource;
  };

  const registerCloseable = <Resource extends Closeable>(
    label: string,
    resource: Resource,
  ): Resource => registerResource(label, resource, (owned) => owned.close());

  const transferResource = (resource: object): void => {
    const index = resources.findIndex((owner) => owner.resource === resource);
    if (index === -1)
      throw new Error('Workflow lifecycle fixture resource owner is missing');
    resources.splice(index, 1);
  };

  return { registerResource, registerCloseable, transferResource };
}
