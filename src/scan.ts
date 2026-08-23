import { basename } from 'node:path';

import { selectAdapter } from './adapters/index.js';
import { canonicalizeUrl } from './decode.js';
import { SurfaceGuardError } from './errors.js';
import { appearsBinary, discoverFiles, readFileStreaming } from './filesystem.js';
import { matchesGlob } from './glob.js';
import { matchPatternRule } from './matcher.js';
import { resolveLimits, validatePolicy } from './policy.js';
import { parseRobots, parseSitemap } from './sitemap.js';
import { VERSION } from './constants.js';
import type {
  ArtifactFile,
  Finding,
  RouteEvidence,
  ScanOptions,
  ScanResult,
  Severity,
} from './types.js';

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  note: 0,
  warning: 1,
  error: 2,
};

function routeMatches(route: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(route, pattern));
}

function normalizeRoute(value: string, maxDecodePasses: number): string {
  try {
    return canonicalizeUrl(value, maxDecodePasses).split('?', 1)[0] ?? '/';
  } catch {
    return value;
  }
}

function evaluateRoutes(
  routes: readonly RouteEvidence[],
  options: ScanOptions,
  maxDecodePasses: number,
): { findings: Finding[]; normalized: Map<string, RouteEvidence> } {
  const findings: Finding[] = [];
  const normalized = new Map<string, RouteEvidence>();
  for (const evidence of routes) {
    const route = normalizeRoute(evidence.route, maxDecodePasses);
    if (!normalized.has(route)) normalized.set(route, evidence);
  }
  const assertions = options.policy.routes;
  if (!assertions) return { findings, normalized };

  for (const [route, evidence] of normalized) {
    if (assertions.allow?.length && !routeMatches(route, assertions.allow)) {
      findings.push({
        ruleId: 'SG2001',
        severity: 'error',
        category: 'route',
        artifactPath: evidence.artifactPath,
        message: 'Produced route is outside the route allow list',
        evidence: route,
        help: 'Remove the route from the public build or add a deliberate allow assertion.',
      });
    }
    if (assertions.deny?.length && routeMatches(route, assertions.deny)) {
      findings.push({
        ruleId: 'SG2002',
        severity: 'error',
        category: 'route',
        artifactPath: evidence.artifactPath,
        message: 'Produced route matches a route deny assertion',
        evidence: route,
        help: 'Remove the route from the produced artifact.',
      });
    }
  }
  for (const required of assertions.require ?? []) {
    if (![...normalized.keys()].some((route) => matchesGlob(route, required))) {
      findings.push({
        ruleId: 'SG2003',
        severity: 'error',
        category: 'route',
        artifactPath: '.',
        message: 'Required route assertion was not satisfied',
        evidence: required,
        help: 'Confirm that the intended public route is present in the produced route manifests.',
      });
    }
  }
  return { findings, normalized };
}

function evaluateSitemap(
  policy: ScanOptions['policy'],
  files: readonly ArtifactFile[],
  texts: ReadonlyMap<string, string>,
  routes: ReadonlyMap<string, RouteEvidence>,
  maxDecodePasses: number,
): Finding[] {
  const settings = policy.sitemap;
  if (!settings || settings.mode === 'off') return [];
  const findings: Finding[] = [];
  const sitemapFiles = files.filter((file) => file.kind === 'sitemap');
  const robotsFile = files.find((file) => file.kind === 'robots');
  if (settings.mode === 'required' && sitemapFiles.length === 0) {
    findings.push({
      ruleId: 'SG4001',
      severity: 'error',
      category: 'sitemap',
      artifactPath: '.',
      message: 'A sitemap is required but no sitemap artifact was found',
    });
    return findings;
  }
  if (sitemapFiles.length === 0) return findings;

  const sitemapRoutes = new Map<string, string>();
  for (const file of sitemapFiles) {
    const text = texts.get(file.relativePath) ?? '';
    for (const route of parseSitemap(text, maxDecodePasses)) {
      sitemapRoutes.set(normalizeRoute(route, maxDecodePasses), file.relativePath);
    }
  }
  const robots = robotsFile
    ? parseRobots(texts.get(robotsFile.relativePath) ?? '')
    : undefined;
  if (settings.requireRobotsReference) {
    if (!robotsFile || !robots || robots.sitemaps.length === 0) {
      findings.push({
        ruleId: 'SG4002',
        severity: 'error',
        category: 'sitemap',
        artifactPath: robotsFile?.relativePath ?? '.',
        message: 'robots.txt does not reference a sitemap',
      });
    }
  }
  for (const [route, artifactPath] of sitemapRoutes) {
    if (
      robots?.disallow.some((pattern) => routeMatches(route, [pattern, `${pattern}/**`]))
    ) {
      findings.push({
        ruleId: 'SG4003',
        severity: 'error',
        category: 'sitemap',
        artifactPath,
        message: 'Sitemap exposes a route disallowed by robots.txt',
        evidence: route,
      });
    }
    if (
      settings.forbidDisallowedRoutes &&
      policy.routes?.deny?.length &&
      routeMatches(route, policy.routes.deny)
    ) {
      findings.push({
        ruleId: 'SG4004',
        severity: 'error',
        category: 'sitemap',
        artifactPath,
        message: 'Sitemap exposes a route denied by policy',
        evidence: route,
      });
    }
    if (routes.size > 0 && !routes.has(route)) {
      findings.push({
        ruleId: 'SG4005',
        severity: 'warning',
        category: 'sitemap',
        artifactPath,
        message: 'Sitemap route was not found in produced route manifests',
        evidence: route,
      });
    }
  }
  if (settings.requireRoutes) {
    for (const [route, evidence] of routes) {
      if (route.includes('[') || route.startsWith('/api/') || route.startsWith('/_'))
        continue;
      if (!sitemapRoutes.has(route)) {
        findings.push({
          ruleId: 'SG4006',
          severity: 'error',
          category: 'sitemap',
          artifactPath: evidence.artifactPath,
          message: 'Produced public route is missing from the sitemap',
          evidence: route,
        });
      }
    }
  }
  return findings;
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (left, right) =>
      left.artifactPath.localeCompare(right.artifactPath) ||
      (left.location?.offset ?? -1) - (right.location?.offset ?? -1) ||
      left.ruleId.localeCompare(right.ruleId) ||
      (left.evidence ?? '').localeCompare(right.evidence ?? ''),
  );
}

export async function scanArtifacts(input: ScanOptions): Promise<ScanResult> {
  const policy = validatePolicy(input.policy);
  const limits = resolveLimits(policy);
  const discovered = await discoverFiles(input.root, limits, policy.exclude ?? []);
  if (input.signal?.aborted)
    throw new SurfaceGuardError('SG_ABORTED', 'Artifact scan was aborted');

  const requestedAdapter = input.adapter ?? policy.adapter ?? 'auto';
  const adapter = selectAdapter(requestedAdapter, discovered.files);
  for (const file of discovered.files)
    file.kind = adapter.classify(file.relativePath) ?? 'unknown';

  const texts = new Map<string, string>();
  const readText = async (file: ArtifactFile): Promise<string> => {
    const cached = texts.get(file.relativePath);
    if (cached !== undefined) return cached;
    const text = await readFileStreaming(file, limits, input.signal);
    texts.set(file.relativePath, text);
    return text;
  };

  const routeResult = await adapter.collectRoutes({
    root: discovered.root,
    files: discovered.files,
    readText,
  });
  const evaluatedRoutes = evaluateRoutes(
    routeResult.routes,
    { ...input, policy },
    limits.maxDecodePasses,
  );
  const findings: Finding[] = [
    ...discovered.findings,
    ...routeResult.findings,
    ...evaluatedRoutes.findings,
  ];
  let filesScanned = 0;

  for (const file of discovered.files) {
    if (input.signal?.aborted)
      throw new SurfaceGuardError('SG_ABORTED', 'Artifact scan was aborted');
    for (const rule of policy.forbidden?.files ?? []) {
      if (matchesGlob(file.relativePath, rule.glob)) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity ?? 'error',
          category: 'file',
          artifactPath: file.relativePath,
          message: rule.message ?? 'Forbidden artifact file pattern matched',
          evidence: file.relativePath,
          help: 'Remove the file from the produced public artifact.',
        });
      }
    }
    if (file.kind === 'source-map' && policy.sourceMaps?.mode === 'forbid') {
      findings.push({
        ruleId: 'SG3001',
        severity: 'error',
        category: 'source-map',
        artifactPath: file.relativePath,
        message: 'Source map file is forbidden by policy',
        evidence: basename(file.relativePath),
      });
    }
    if (file.kind === 'unknown') continue;

    const text = await readText(file);
    if (appearsBinary(text)) continue;
    filesScanned += 1;

    if (policy.sourceMaps?.mode === 'forbid') {
      const directive = /[/#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/giu;
      let match: RegExpExecArray | null;
      while ((match = directive.exec(text)) !== null) {
        const inline = match[1]?.startsWith('data:') ?? false;
        if (inline && policy.sourceMaps.inline === 'allow') continue;
        findings.push({
          ruleId: inline ? 'SG3002' : 'SG3003',
          severity: 'error',
          category: 'source-map',
          artifactPath: file.relativePath,
          message: inline
            ? 'Inline source map is forbidden by policy'
            : 'Source map reference is forbidden by policy',
          evidence: match[0],
          location: {
            line: text.slice(0, match.index).split('\n').length,
            column: match.index - text.lastIndexOf('\n', match.index - 1),
            offset: match.index,
          },
        });
      }
    }

    const groups = [
      ['text', policy.forbidden?.text ?? []],
      ['endpoint', policy.forbidden?.endpoints ?? []],
      ['metadata', file.kind === 'metadata' ? (policy.forbidden?.metadata ?? []) : []],
    ] as const;
    for (const [category, rules] of groups) {
      for (const rule of rules) {
        findings.push(...matchPatternRule(text, file, rule, category, limits));
        if (findings.length >= limits.maxFindings) break;
      }
      if (findings.length >= limits.maxFindings) break;
    }
    if (findings.length >= limits.maxFindings) break;
  }

  for (const file of discovered.files.filter(
    (candidate) => candidate.kind === 'sitemap' || candidate.kind === 'robots',
  )) {
    if (!texts.has(file.relativePath)) await readText(file);
  }
  findings.push(
    ...evaluateSitemap(
      policy,
      discovered.files,
      texts,
      evaluatedRoutes.normalized,
      limits.maxDecodePasses,
    ),
  );
  if (findings.length > limits.maxFindings) findings.length = limits.maxFindings;
  const sorted = sortFindings(findings);
  const failOn = policy.failOn ?? 'error';

  return {
    schemaVersion: 1,
    tool: { name: 'surfaceguard', version: VERSION },
    root: '.',
    adapter: adapter.name,
    findings: sorted,
    statistics: {
      filesVisited: discovered.files.length,
      filesScanned,
      bytesVisited: discovered.files.reduce((total, file) => total + file.size, 0),
      routesFound: evaluatedRoutes.normalized.size,
    },
    failed: sorted.some(
      (finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[failOn],
    ),
  };
}
