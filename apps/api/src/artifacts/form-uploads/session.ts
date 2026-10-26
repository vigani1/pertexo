import { formUploadSessionSchema } from '@pertexo/contracts';
import {
  firstRequestHeader,
  type RequestHeaders,
} from '../../platform/http/request-headers.js';

const HEADER = 'x-pertexo-form-session';

export function uploadSession(headers: RequestHeaders): string {
  return formUploadSessionSchema.parse(firstRequestHeader(headers, HEADER));
}

/** Submissions name the session only when they reference uploads. */
export function optionalUploadSession(
  headers: RequestHeaders,
): Readonly<{ uploadSession?: string }> {
  return firstRequestHeader(headers, HEADER) === undefined
    ? {}
    : { uploadSession: uploadSession(headers) };
}
