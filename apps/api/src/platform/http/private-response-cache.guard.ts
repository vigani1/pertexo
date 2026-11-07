import type { CanActivate, ExecutionContext, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';

export const PRIVATE_AUTHENTICATION = Symbol('PRIVATE_AUTHENTICATION');

export function usesPrivateAuthentication(
  controller: object,
  handler: object,
): boolean {
  return [controller, handler].some((target) => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, target) ??
      []) as Type[];
    return guards.some(
      (guard) => Reflect.getMetadata(PRIVATE_AUTHENTICATION, guard) === true,
    );
  });
}

/** Global guards run before controller and handler guards can refuse a request. */
export class PrivateResponseCacheGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    if (usesPrivateAuthentication(context.getClass(), context.getHandler())) {
      context
        .switchToHttp()
        .getResponse<{ header(name: string, value: string): void }>()
        .header('Cache-Control', 'private, no-store');
    }
    return true;
  }
}
