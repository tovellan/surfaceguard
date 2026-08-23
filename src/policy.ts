import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DEFAULT_LIMITS } from './constants.js';
import { SurfaceGuardError } from './errors.js';
import type {
  FileRule,
  PatternRule,
  ScanLimits,
  Severity,
  SurfaceGuardPolicy,
} from './types.js';

const SEVERITIES = new Set<Severity>(['error', 'warning', 'note']);
const ADAPTERS = new Set(['auto', 'generic', 'nextjs']);
const SCOPES = new Set([
  'all',
  'route-manifest',
  'client-chunk',
  'server-bundle',
  'static-asset',
  'source-map',
  'sitemap',
  'robots',
  'metadata',
  'unknown',
]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path} must be an object`, { path });
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path} must be an array of non-empty strings`,
      {
        path,
      },
    );
  }
  return value as string[];
}

function assertKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path} contains unknown properties`,
      {
        path,
        unknown,
      },
    );
  }
}

function validatePatternRule(value: unknown, path: string): PatternRule {
  const item = record(value, path);
  assertKnownKeys(
    item,
    ['id', 'pattern', 'match', 'caseSensitive', 'severity', 'scopes', 'message'],
    path,
  );
  if (typeof item.id !== 'string' || !/^[a-z][a-z0-9._-]+$/u.test(item.id)) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.id has an invalid rule identifier`,
      { path },
    );
  }
  if (typeof item.pattern !== 'string' || item.pattern.length === 0) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.pattern must be a non-empty string`,
      { path },
    );
  }
  if (item.match !== undefined && item.match !== 'literal' && item.match !== 'regex') {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.match must be literal or regex`,
      { path },
    );
  }
  if (item.caseSensitive !== undefined && typeof item.caseSensitive !== 'boolean') {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.caseSensitive must be boolean`,
      { path },
    );
  }
  if (item.severity !== undefined && !SEVERITIES.has(item.severity as Severity)) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path}.severity is invalid`, {
      path,
    });
  }
  const scopes = strings(item.scopes, `${path}.scopes`);
  if (scopes?.some((scope) => !SCOPES.has(scope))) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.scopes contains an invalid scope`,
      { path },
    );
  }
  if (item.message !== undefined && typeof item.message !== 'string') {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path}.message must be a string`, {
      path,
    });
  }
  return item as unknown as PatternRule;
}

function validateFileRule(value: unknown, path: string): FileRule {
  const item = record(value, path);
  assertKnownKeys(item, ['id', 'glob', 'severity', 'message'], path);
  if (typeof item.id !== 'string' || !/^[a-z][a-z0-9._-]+$/u.test(item.id)) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.id has an invalid rule identifier`,
      { path },
    );
  }
  if (typeof item.glob !== 'string' || item.glob.length === 0) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.glob must be a non-empty string`,
      { path },
    );
  }
  if (item.severity !== undefined && !SEVERITIES.has(item.severity as Severity)) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path}.severity is invalid`, {
      path,
    });
  }
  if (item.message !== undefined && typeof item.message !== 'string') {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path}.message must be a string`, {
      path,
    });
  }
  return item as unknown as FileRule;
}

function validatePatternRules(value: unknown, path: string): PatternRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path} must be an array`, { path });
  }
  return value.map((item, index) => validatePatternRule(item, `${path}[${index}]`));
}

function validateFileRules(value: unknown, path: string): FileRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path} must be an array`, { path });
  }
  return value.map((item, index) => validateFileRule(item, `${path}[${index}]`));
}

export function validatePolicy(value: unknown): SurfaceGuardPolicy {
  const root = record(value, '$');
  assertKnownKeys(
    root,
    [
      'schemaVersion',
      'adapter',
      'failOn',
      'exclude',
      'routes',
      'sourceMaps',
      'forbidden',
      'sitemap',
      'limits',
    ],
    '$',
  );
  if (root.schemaVersion !== 1) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', 'schemaVersion must be 1', {
      path: '$.schemaVersion',
      received: root.schemaVersion,
    });
  }
  if (
    root.adapter !== undefined &&
    (typeof root.adapter !== 'string' || !ADAPTERS.has(root.adapter))
  ) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      'adapter must be auto, generic, or nextjs',
      {
        path: '$.adapter',
      },
    );
  }
  if (root.failOn !== undefined && !SEVERITIES.has(root.failOn as Severity)) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', 'failOn is invalid', {
      path: '$.failOn',
    });
  }
  strings(root.exclude, '$.exclude');

  if (root.routes !== undefined) {
    const routes = record(root.routes, '$.routes');
    assertKnownKeys(routes, ['allow', 'deny', 'require'], '$.routes');
    strings(routes.allow, '$.routes.allow');
    strings(routes.deny, '$.routes.deny');
    strings(routes.require, '$.routes.require');
  }
  if (root.sourceMaps !== undefined) {
    const maps = record(root.sourceMaps, '$.sourceMaps');
    assertKnownKeys(maps, ['mode', 'inline'], '$.sourceMaps');
    if (maps.mode !== 'allow' && maps.mode !== 'forbid') {
      throw new SurfaceGuardError(
        'SG_CONFIG_INVALID',
        '$.sourceMaps.mode must be allow or forbid',
      );
    }
    if (maps.inline !== undefined && maps.inline !== 'allow' && maps.inline !== 'forbid') {
      throw new SurfaceGuardError(
        'SG_CONFIG_INVALID',
        '$.sourceMaps.inline must be allow or forbid',
      );
    }
  }
  if (root.forbidden !== undefined) {
    const forbidden = record(root.forbidden, '$.forbidden');
    assertKnownKeys(forbidden, ['text', 'endpoints', 'metadata', 'files'], '$.forbidden');
    validatePatternRules(forbidden.text, '$.forbidden.text');
    validatePatternRules(forbidden.endpoints, '$.forbidden.endpoints');
    validatePatternRules(forbidden.metadata, '$.forbidden.metadata');
    validateFileRules(forbidden.files, '$.forbidden.files');
  }
  if (root.sitemap !== undefined) {
    const sitemap = record(root.sitemap, '$.sitemap');
    assertKnownKeys(
      sitemap,
      ['mode', 'requireRobotsReference', 'requireRoutes', 'forbidDisallowedRoutes'],
      '$.sitemap',
    );
    if (
      sitemap.mode !== undefined &&
      (typeof sitemap.mode !== 'string' ||
        !['off', 'if-present', 'required'].includes(sitemap.mode))
    ) {
      throw new SurfaceGuardError('SG_CONFIG_INVALID', '$.sitemap.mode is invalid');
    }
    for (const key of [
      'requireRobotsReference',
      'requireRoutes',
      'forbidDisallowedRoutes',
    ]) {
      if (sitemap[key] !== undefined && typeof sitemap[key] !== 'boolean') {
        throw new SurfaceGuardError(
          'SG_CONFIG_INVALID',
          `$.sitemap.${key} must be boolean`,
        );
      }
    }
  }
  if (root.limits !== undefined) {
    const limits = record(root.limits, '$.limits');
    assertKnownKeys(limits, Object.keys(DEFAULT_LIMITS), '$.limits');
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new SurfaceGuardError(
          'SG_CONFIG_INVALID',
          `$.limits.${key} must be a positive integer`,
        );
      }
    }
  }
  return value as SurfaceGuardPolicy;
}

export async function loadPolicy(path: string): Promise<SurfaceGuardPolicy> {
  const absolutePath = resolve(path);
  let source: string;
  try {
    source = await readFile(absolutePath, 'utf8');
  } catch (error) {
    throw new SurfaceGuardError('SG_IO_ERROR', `Unable to read policy: ${absolutePath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return validatePolicy(JSON.parse(source) as unknown);
  } catch (error) {
    if (error instanceof SurfaceGuardError) throw error;
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `Policy is not valid JSON: ${absolutePath}`,
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export function resolveLimits(policy: SurfaceGuardPolicy): ScanLimits {
  return { ...DEFAULT_LIMITS, ...policy.limits };
}
