export function createHttpProofResourceOwners() {
  const owners: {
    close: () => unknown;
    label: string;
    resource: object;
  }[] = [];
  const own = <Resource extends object>(
    label: string,
    resource: Resource,
    close: (resource: Resource) => unknown,
  ): Resource => {
    let closePromise: Promise<void> | undefined;
    owners.push({
      label,
      resource,
      close: () => {
        closePromise ??= Promise.resolve()
          .then(() => close(resource))
          .then(() => undefined);
        return closePromise;
      },
    });
    return resource;
  };
  const transfer = (resource: object): void => {
    const index = owners.findIndex((owner) => owner.resource === resource);
    if (index === -1)
      throw new Error('HTTP attempt proof runtime owner is missing');
    owners.splice(index, 1);
  };

  return { owners, own, transfer };
}
