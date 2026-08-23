import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DEFAULT_LIMITS } from './constants.js';
import { SurfaceGuardError } from './errors.js';
import { globToRegExp } from './glob.js';
import { compilePatternRule } from './matcher.js';
import { MAX_RETAINED_MESSAGE_BYTES, MAX_RETAINED_RULE_ID_BYTES } from './output-safety.js';
import type {
  FileRule,
  PatternRule,
  ScanLimits,
  Severity,
  SurfaceGuardPolicy,
} from './types.js';

const SEVERITIES = new Set<Severity>(['error', 'warning', 'note']);
const ADAPTERS = new Set(['auto', 'astro', 'generic', 'nextjs', 'vite']);
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
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path} must be an array of non-empty strings`,
      {
        path,
      },
    );
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index] as unknown;
    if (typeof item !== 'string' || item.length === 0) {
      throw new SurfaceGuardError(
        'SG_CONFIG_INVALID',
        `${path}[${index}] must be a non-empty string`,
        { path: `${path}[${index}]` },
      );
    }
    result.push(item);
  }
  const firstIndexes = new Map<string, number>();
  for (const [index, item] of result.entries()) {
    const firstIndex = firstIndexes.get(item);
    if (firstIndex !== undefined) {
      throw new SurfaceGuardError(
        'SG_CONFIG_INVALID',
        `${path}[${index}] duplicates ${path}[${firstIndex}]`,
        {
          path: `${path}[${index}]`,
          duplicateOf: `${path}[${firstIndex}]`,
        },
      );
    }
    firstIndexes.set(item, index);
  }
  return result;
}

function validateGlob(glob: string, path: string, limits: ScanLimits): void {
  if (glob.length > limits.maxPatternLength) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path} exceeds maxPatternLength`, {
      path,
      limit: limits.maxPatternLength,
    });
  }
  try {
    globToRegExp(glob);
  } catch (error) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path} is not a valid glob`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
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
  if (Buffer.byteLength(item.id, 'utf8') > MAX_RETAINED_RULE_ID_BYTES) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.id exceeds the output-safe identifier limit`,
      { path: `${path}.id`, limit: MAX_RETAINED_RULE_ID_BYTES },
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
  if (
    typeof item.message === 'string' &&
    Buffer.byteLength(item.message, 'utf8') > MAX_RETAINED_MESSAGE_BYTES
  ) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.message exceeds the output-safe message limit`,
      { path: `${path}.message`, limit: MAX_RETAINED_MESSAGE_BYTES },
    );
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
  if (Buffer.byteLength(item.id, 'utf8') > MAX_RETAINED_RULE_ID_BYTES) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.id exceeds the output-safe identifier limit`,
      { path: `${path}.id`, limit: MAX_RETAINED_RULE_ID_BYTES },
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
  if (
    typeof item.message === 'string' &&
    Buffer.byteLength(item.message, 'utf8') > MAX_RETAINED_MESSAGE_BYTES
  ) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `${path}.message exceeds the output-safe message limit`,
      { path: `${path}.message`, limit: MAX_RETAINED_MESSAGE_BYTES },
    );
  }
  return item as unknown as FileRule;
}

function validatePatternRules(value: unknown, path: string): PatternRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path} must be an array`, { path });
  }
  return Array.from(value, (item, index) => validatePatternRule(item, `${path}[${index}]`));
}

function validateFileRules(value: unknown, path: string): FileRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${path} must be an array`, { path });
  }
  return Array.from(value, (item, index) => validateFileRule(item, `${path}[${index}]`));
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
      'adapter must be auto, astro, generic, nextjs, or vite',
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
  const globs: { glob: string; path: string }[] = [];
  const patternRules: { rules: PatternRule[]; path: string }[] = [];
  const exclude = strings(root.exclude, '$.exclude');
  exclude?.forEach((glob, index) => globs.push({ glob, path: `$.exclude[${index}]` }));

  if (root.routes !== undefined) {
    const routes = record(root.routes, '$.routes');
    assertKnownKeys(routes, ['allow', 'deny', 'require'], '$.routes');
    for (const key of ['allow', 'deny', 'require'] as const) {
      const routeGlobs = strings(routes[key], `$.routes.${key}`);
      if (key === 'allow' && routeGlobs?.length === 0) {
        throw new SurfaceGuardError(
          'SG_CONFIG_INVALID',
          '$.routes.allow must contain at least one route pattern when present',
          { path: '$.routes.allow' },
        );
      }
      routeGlobs?.forEach((glob, index) =>
        globs.push({ glob, path: `$.routes.${key}[${index}]` }),
      );
    }
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
    for (const key of ['text', 'endpoints', 'metadata'] as const) {
      const path = `$.forbidden.${key}`;
      const rules = validatePatternRules(forbidden[key], path);
      if (rules) patternRules.push({ rules, path });
    }
    const fileRules = validateFileRules(forbidden.files, '$.forbidden.files');
    fileRules?.forEach((rule, index) =>
      globs.push({ glob: rule.glob, path: `$.forbidden.files[${index}].glob` }),
    );
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
        const path = `$.limits.${key}`;
        throw new SurfaceGuardError(
          'SG_CONFIG_INVALID',
          `${path} must be a positive integer`,
          { path },
        );
      }
    }
  }

  const limits: ScanLimits = {
    ...DEFAULT_LIMITS,
    ...(root.limits as Partial<ScanLimits> | undefined),
  };
  for (const { glob, path } of globs) validateGlob(glob, path, limits);
  for (const { rules, path } of patternRules) {
    rules.forEach((rule, index) =>
      compilePatternRule(rule, limits, `${path}[${index}].pattern`),
    );
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
