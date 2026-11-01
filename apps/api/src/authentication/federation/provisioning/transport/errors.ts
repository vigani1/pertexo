import type { FastifyReply } from 'fastify';
import { DirectoryError } from '@pertexo/core/tenant-access';

export function sendDirectoryError(
  reply: FastifyReply,
  status: number,
  detail: string,
  scimType?: string,
): void {
  reply
    .code(status)
    .header('cache-control', 'no-store')
    .type('application/scim+json')
    .send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: String(status),
      detail,
      ...(scimType === undefined ? {} : { scimType }),
    });
}
export function directoryFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof DirectoryError) {
    const failures: Record<
      DirectoryError['reason'],
      readonly [number, string, string?]
    > = {
      unauthorized: [
        401,
        'A current provisioning bearer credential is required.',
      ],
      forbidden: [403, 'This directory operation is not allowed.'],
      not_found: [404, 'Directory resource not found.'],
      stale: [
        412,
        'The directory resource changed. Reload it before retrying.',
        'invalidVers',
      ],
      limit: [
        413,
        'The directory request or result exceeds its limit. Send fewer operations, members or attributes.',
        'tooMany',
      ],
      invalid_value: [
        400,
        'Use the supported core attributes and valid bounded values.',
        'invalidValue',
      ],
      invalid_filter: [
        400,
        'Use a supported, bounded SCIM filter.',
        'invalidFilter',
      ],
      invalid_path: [
        400,
        'Use a supported SCIM attribute path.',
        'invalidPath',
      ],
      no_target: [400, 'No value matches the PATCH path.', 'noTarget'],
      mutability: [
        400,
        'Server-managed attributes cannot be changed.',
        'mutability',
      ],
      uniqueness: [
        409,
        'The directory identifier is already in use.',
        'uniqueness',
      ],
      owner_protected: [403, 'The recovery owner cannot be directory-managed.'],
    };
    const [status, detail, type] = failures[error.reason];
    if (status === 401) reply.header('www-authenticate', 'Bearer');
    sendDirectoryError(reply, status, detail, type);
    return;
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  switch (code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      sendDirectoryError(
        reply,
        413,
        'Provisioning requests must fit within 1 MB.',
        'tooMany',
      );
      return;
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      sendDirectoryError(
        reply,
        415,
        'Use application/scim+json or application/json.',
      );
      return;
  }
  const invalidJson =
    error instanceof SyntaxError ||
    code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    code === 'FST_ERR_CTP_INVALID_JSON_BODY';
  if (invalidJson) {
    sendDirectoryError(
      reply,
      400,
      'The request must contain valid SCIM JSON.',
      'invalidSyntax',
    );
    return;
  }
  sendDirectoryError(reply, 500, 'Provisioning is temporarily unavailable.');
}
