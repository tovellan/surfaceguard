import { SurfaceGuardError, throwIfAborted } from '../errors.js';
import type { AdapterContext, RouteEvidence } from '../types.js';

export class AdapterBudget {
  private manifestEntries = 0;

  public constructor(private readonly context: AdapterContext) {}

  public checkSignal(): void {
    throwIfAborted(this.context.signal);
  }

  public inspectManifest(value: unknown, artifactPath: string): void {
    const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
    while (pending.length > 0) {
      this.checkSignal();
      const current = pending.pop();
      if (!current) continue;
      if (Array.isArray(current.value)) {
        for (const child of current.value) {
          this.visitManifestEntry(artifactPath);
          this.checkManifestDepth(current.depth + 1, artifactPath);
          pending.push({ value: child, depth: current.depth + 1 });
        }
      } else if (current.value && typeof current.value === 'object') {
        const record = current.value as Record<string, unknown>;
        for (const key in record) {
          if (!Object.hasOwn(record, key)) continue;
          this.visitManifestEntry(artifactPath);
          this.checkManifestDepth(current.depth + 1, artifactPath);
          pending.push({ value: record[key], depth: current.depth + 1 });
        }
      }
    }
  }

  public addRoute(routes: RouteEvidence[], evidence: RouteEvidence): void {
    this.checkSignal();
    if (routes.length + 1 > this.context.limits.maxRoutes) {
      throw new SurfaceGuardError(
        'SG_RESOURCE_LIMIT',
        'Route evidence count exceeds maxRoutes',
        {
          artifactPath: evidence.artifactPath,
          limit: this.context.limits.maxRoutes,
          observed: routes.length + 1,
        },
      );
    }
    routes.push(evidence);
  }

  private visitManifestEntry(artifactPath: string): void {
    this.checkSignal();
    this.manifestEntries += 1;
    if (this.manifestEntries > this.context.limits.maxManifestEntries) {
      throw new SurfaceGuardError(
        'SG_RESOURCE_LIMIT',
        'Manifest entry count exceeds maxManifestEntries',
        {
          artifactPath,
          limit: this.context.limits.maxManifestEntries,
          observed: this.manifestEntries,
        },
      );
    }
  }

  private checkManifestDepth(depth: number, artifactPath: string): void {
    if (depth > this.context.limits.maxDepth) {
      throw new SurfaceGuardError('SG_RESOURCE_LIMIT', 'Manifest depth exceeds maxDepth', {
        artifactPath,
        limit: this.context.limits.maxDepth,
        observed: depth,
      });
    }
  }
}
