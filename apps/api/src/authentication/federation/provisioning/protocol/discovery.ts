import { DIRECTORY_LIMITS } from '@pertexo/contracts';
import {
  coreSchema,
  supportedAttributes,
  type DirectoryResourceType,
} from './core.js';

const list = (Resources: readonly unknown[]) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
  totalResults: Resources.length,
  startIndex: 1,
  itemsPerPage: Resources.length,
  Resources,
});
export function directoryDiscovery(path: string, base: string): unknown {
  if (path === 'ServiceProviderConfig')
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: DIRECTORY_LIMITS.page },
      changePassword: { supported: false },
      sort: { supported: true },
      etag: { supported: true },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Organization provisioning bearer',
          description:
            'An owner-generated organization-scoped bearer credential.',
          primary: true,
        },
      ],
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: `${base}/ServiceProviderConfig`,
      },
    };
  const kinds: readonly DirectoryResourceType[] = ['User', 'Group'];
  if (path === 'ResourceTypes' || path.startsWith('ResourceTypes/')) {
    const resources = kinds.map((kind) => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: kind,
      name: kind,
      endpoint: `/${kind}s`,
      schema: coreSchema(kind).id,
      schemaExtensions: [],
      meta: {
        resourceType: 'ResourceType',
        location: `${base}/ResourceTypes/${kind}`,
      },
    }));
    return path === 'ResourceTypes'
      ? list(resources)
      : resources.find((resource) => path === `ResourceTypes/${resource.id}`);
  }
  if (path === 'Schemas' || path.startsWith('Schemas/')) {
    const resources = kinds.map((kind) => {
      const described = coreSchema(kind).definition.describe(`${base}/Schemas`),
        supported = new Set(
          supportedAttributes(kind).map((attribute) => attribute.name),
        );
      return {
        ...described,
        attributes: described.attributes
          .filter((attribute) => supported.has(attribute.name))
          .map((attribute) =>
            kind !== 'Group' || attribute.name !== 'members'
              ? attribute
              : {
                  ...attribute,
                  subAttributes: attribute.subAttributes?.map((child) => {
                    if (child.name === 'type')
                      return { ...child, canonicalValues: ['User'] };
                    if (child.name === '$ref')
                      return { ...child, referenceTypes: ['User'] };
                    return child;
                  }),
                },
          ),
      };
    });
    return path === 'Schemas'
      ? list(resources)
      : resources.find((resource) => path === `Schemas/${resource.id}`);
  }
  return undefined;
}
