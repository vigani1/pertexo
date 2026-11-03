import { Injectable } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';

type RegisteredRoute = Readonly<{
  methods: readonly string[];
  segments: readonly string[];
}>;

function pathSegments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function matches(pattern: readonly string[], path: readonly string[]): boolean {
  for (const [index, segment] of pattern.entries()) {
    if (segment === '*') return true;
    const value = path[index];
    if (value === undefined) return false;
    if (!segment.startsWith(':') && segment !== value) return false;
  }
  return pattern.length === path.length;
}

/**
 * Fastify's router answers only "no route": it doesn't say the path exists under
 * another method. It's looked at only for requests that matched nothing.
 */
@Injectable()
export class RouteTable {
  private readonly routes: RegisteredRoute[] = [];

  public register(fastify: FastifyInstance): void {
    fastify.addHook('onRoute', ({ method, url }) => {
      this.routes.push({
        methods: Array.isArray(method) ? method : [method],
        segments: pathSegments(url),
      });
    });
  }

  /** The methods a path takes, empty when no route has that path. */
  public allowedMethods(url: string): readonly string[] {
    const path = pathSegments(url.replace(/[?#].*$/u, ''));
    const methods = this.routes
      .filter((route) => matches(route.segments, path))
      .flatMap((route) => route.methods);
    return [...new Set(methods)].toSorted();
  }
}
