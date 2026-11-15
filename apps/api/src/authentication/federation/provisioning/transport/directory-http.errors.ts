import { recordAuthenticationFailure } from '../../../journeys/failures.js';
import { HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DirectoryError } from '@pertexo/core/identity';
import { formatByteSize } from '@pertexo/node-sdk';
import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';

export function sendDirectoryError(
  reply: FastifyReply,
  status: number,
  detail: string,
  scimType?: string,
): void {
  reply
    .code(status)
    .header('cache-control', 'no-store')
    .header('x-request-id', reply.request.id)
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
    recordAuthenticationFailure(
      reply.request.id,
      'directory',
      error.reason,
      'refused',
    );
    const failures: Record<
      DirectoryError['reason'],
      readonly [number, string, string?]
    > = {
      unauthorized: [
        HttpStatus.UNAUTHORIZED,
        'A current provisioning bearer credential is required.',
      ],
      forbidden: [
        HttpStatus.FORBIDDEN,
        'This directory operation is not allowed.',
      ],
      not_found: [HttpStatus.NOT_FOUND, 'Directory resource not found.'],
      stale: [
        HttpStatus.PRECONDITION_FAILED,
        'The directory resource changed. Reload it before retrying.',
        'invalidVers',
      ],
      limit: [
        HttpStatus.PAYLOAD_TOO_LARGE,
        'The directory request or result exceeds its limit. Send fewer operations, members or attributes.',
        'tooMany',
      ],
      invalid_value: [
        HttpStatus.BAD_REQUEST,
        'Use the supported core attributes and valid bounded values.',
        'invalidValue',
      ],
      invalid_filter: [
        HttpStatus.BAD_REQUEST,
        'Use a supported, bounded SCIM filter.',
        'invalidFilter',
      ],
      invalid_path: [
        HttpStatus.BAD_REQUEST,
        'Use a supported SCIM attribute path.',
        'invalidPath',
      ],
      no_target: [
        HttpStatus.BAD_REQUEST,
        'No value matches the PATCH path.',
        'noTarget',
      ],
      mutability: [
        HttpStatus.BAD_REQUEST,
        'Server-managed attributes cannot be changed.',
        'mutability',
      ],
      uniqueness: [
        HttpStatus.CONFLICT,
        'The directory identifier is already in use.',
        'uniqueness',
      ],
      owner_protected: [
        HttpStatus.FORBIDDEN,
        'The recovery owner cannot be directory-managed.',
      ],
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
      recordAuthenticationFailure(
        reply.request.id,
        'directory',
        'request_invalid',
        'refused',
      );
      sendDirectoryError(
        reply,
        HttpStatus.PAYLOAD_TOO_LARGE,
        `Provisioning requests must fit within ${formatByteSize(DIRECTORY_LIMITS.requestBytes)}.`,
        'tooMany',
      );
      return;
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      recordAuthenticationFailure(
        reply.request.id,
        'directory',
        'request_invalid',
        'refused',
      );
      sendDirectoryError(
        reply,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'Use application/scim+json or application/json.',
      );
      return;
  }
  const invalidJson =
    error instanceof SyntaxError ||
    code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    code === 'FST_ERR_CTP_INVALID_JSON_BODY';
  if (invalidJson) {
    recordAuthenticationFailure(
      reply.request.id,
      'directory',
      'request_invalid',
      'refused',
    );
    sendDirectoryError(
      reply,
      HttpStatus.BAD_REQUEST,
      'The request must contain valid SCIM JSON.',
      'invalidSyntax',
    );
    return;
  }
  recordAuthenticationFailure(
    reply.request.id,
    'directory',
    'internal_failure',
    'failed',
  );
  sendDirectoryError(
    reply,
    HttpStatus.INTERNAL_SERVER_ERROR,
    'Provisioning is temporarily unavailable.',
  );
}
