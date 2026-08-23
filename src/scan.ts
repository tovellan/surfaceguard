import { basename, extname } from 'node:path';

import { selectAdapter } from './adapters/index.js';
import { canonicalizeUrl } from './decode.js';
import { SurfaceGuardError } from './errors.js';
import { discoverFiles, readFileStreaming, readGzipTextStreaming } from './filesystem.js';
import { matchesGlob } from './glob.js';
import { matchPatternRule } from './matcher.js';
import { boundFindingEvidence, MAX_RETAINED_EVIDENCE_BYTES } from './output-safety.js';
import { resolveLimits, validatePolicy } from './policy.js';
import {
  compileRobotsRule,
  matchesCompiledRobotsRule,
  normalizeRobotsPath,
  parseRobots,
  parseSitemap,
} from './sitemap.js';
import { VERSION } from './constants.js';
import type {
  ArtifactFile,
  Finding,
  RouteEvidence,
  ScanLimits,
  ScanOptions,
  ScanResult,
  Severity,
} from './types.js';

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  note: 0,
  warning: 1,
  error: 2,
};

const KNOWN_BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.avif',
  '.bin',
  '.bmp',
  '.br',
  '.eot',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.rar',
  '.tar',
  '.tif',
  '.tiff',
  '.ttf',
  '.wasm',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

function hasKnownBinaryExtension(file: ArtifactFile): boolean {
  return KNOWN_BINARY_EXTENSIONS.has(extname(file.relativePath).toLowerCase());
}

function ambiguousUnknownLooksTextual(text: string): boolean {
  let characters = 0;
  let textCharacters = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    characters += 1;
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0xa0 && codePoint !== 0xfffd)
    ) {
      textCharacters += 1;
    }
  }
  return characters > 0 && textCharacters / characters >= 0.85;
}

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

const ASTRO_ERROR_DOCUMENTS = new Set(['404.html', '500.html']);
const NEXT_ERROR_ROUTES = new Set(['/404', '/500']);

function frameworkErrorRoutes(
  adapterName: string,
  routes: readonly RouteEvidence[],
  maxDecodePasses: number,
): ReadonlySet<string> {
  const errors = new Set<string>();
  for (const evidence of routes) {
    const route = normalizeRoute(
      evidence.route,
      evidence.routeKind === 'artifact-path' ? 0 : maxDecodePasses,
    );
    if (
      adapterName === 'astro' &&
      evidence.routeKind === 'artifact-path' &&
      ASTRO_ERROR_DOCUMENTS.has(evidence.artifactPath)
    ) {
      errors.add(route);
    }
    if (
      adapterName === 'nextjs' &&
      basename(evidence.artifactPath) === 'pages-manifest.json' &&
      NEXT_ERROR_ROUTES.has(route)
    ) {
      errors.add(route);
    }
  }
  return errors;
}

function evaluateRoutes(
  routes: readonly RouteEvidence[],
  options: ScanOptions,
  maxDecodePasses: number,
): { findings: Finding[]; normalized: Map<string, RouteEvidence> } {
  const findings: Finding[] = [];
  const normalized = new Map<string, RouteEvidence>();
  for (const evidence of routes) {
    const route = normalizeRoute(
      evidence.route,
      evidence.routeKind === 'artifact-path' ? 0 : maxDecodePasses,
    );
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
  excludedFrameworkRoutes: ReadonlySet<string>,
  limits: Readonly<ScanLimits>,
  signal?: AbortSignal,
): Finding[] {
  const settings = policy.sitemap;
  if (!settings || settings.mode === 'off') return [];
  const findings: Finding[] = [];
  const sitemapFiles = files.filter((file) => file.kind === 'sitemap');
  const robotsFile = files.find(
    (file) => file.kind === 'robots' && file.relativePath === 'robots.txt',
  );
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
  const sitemapUrls = new Map<string, string>();
  let entriesVisited = 0;
  for (const file of sitemapFiles) {
    const text = texts.get(file.relativePath) ?? '';
    const parsed = parseSitemap(text, limits.maxDecodePasses, {
      maxEntries: limits.maxSitemapEntries,
      entriesVisited,
      ...(signal ? { signal } : {}),
    });
    entriesVisited = parsed.entriesVisited;
    for (const route of parsed.routes) {
      const normalizedRoute = normalizeRoute(route, limits.maxDecodePasses);
      sitemapRoutes.set(normalizedRoute, file.relativePath);
    }
    for (const pathAndQuery of parsed.robotsPaths) {
      sitemapUrls.set(pathAndQuery, file.relativePath);
    }
  }
  const robots = robotsFile
    ? parseRobots(texts.get(robotsFile.relativePath) ?? '', {
        maxRules: limits.maxRobotsRules ?? 50_000,
        maxRuleLength: limits.maxPatternLength,
        ...(signal ? { signal } : {}),
      })
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
  let robotsComparisons = 0;
  let robotsWork = 0;
  const maxRobotsComparisons = limits.maxRobotsComparisons ?? 1_000_000;
  const maxRobotsWork = limits.maxRobotsWork ?? 64 * 1024 * 1024;
  const compiledDisallow = (robots?.disallow ?? []).map(compileRobotsRule);
  const disallowedByRobots = (pathAndQuery: string): boolean => {
    const normalizedPathAndQuery = normalizeRobotsPath(pathAndQuery);
    for (const pattern of compiledDisallow) {
      robotsComparisons += 1;
      robotsWork += normalizedPathAndQuery.length + pattern.pattern.length + 1;
      if ((robotsComparisons & 0xfff) === 0 && signal?.aborted) {
        throw new SurfaceGuardError('SG_ABORTED', 'Artifact scan was aborted');
      }
      if (robotsComparisons > maxRobotsComparisons) {
        throw new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Sitemap and robots.txt comparisons exceed maxRobotsComparisons',
          { limit: maxRobotsComparisons, observed: robotsComparisons },
        );
      }
      if (robotsWork > maxRobotsWork) {
        throw new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Sitemap and robots.txt matching exceeds maxRobotsWork',
          { limit: maxRobotsWork, observed: robotsWork },
        );
      }
      if (matchesCompiledRobotsRule(normalizedPathAndQuery, pattern)) return true;
    }
    return false;
  };
  for (const [pathAndQuery, artifactPath] of sitemapUrls) {
    if (disallowedByRobots(pathAndQuery)) {
      findings.push({
        ruleId: 'SG4003',
        severity: 'error',
        category: 'sitemap',
        artifactPath,
        message: 'Sitemap exposes a route disallowed by robots.txt',
        evidence: pathAndQuery,
      });
    }
  }
  for (const [route, artifactPath] of sitemapRoutes) {
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
      if (
        route.includes('[') ||
        route.startsWith('/api/') ||
        route.startsWith('/_') ||
        excludedFrameworkRoutes.has(route)
      ) {
        continue;
      }
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

function encodingFinding(file: ArtifactFile): Finding {
  return {
    ruleId: 'SG1003',
    severity: 'error',
    category: 'filesystem',
    artifactPath: file.relativePath,
    message: 'Text artifact uses an unsupported or ambiguous encoding',
    help: 'Encode textual public artifacts as valid UTF-8 or BOM-tagged UTF-16LE/BE.',
  };
}

class FindingCollector {
  readonly findings: Finding[] = [];
  truncated = false;
  failureObserved = false;
  observedFindingsAtLeast = 0;

  constructor(
    private readonly maximum: number,
    private readonly failOn: Severity,
  ) {}

  add(finding: Finding): void {
    this.observedFindingsAtLeast += 1;
    const rank = SEVERITY_RANK[finding.severity];
    if (rank >= SEVERITY_RANK[this.failOn]) this.failureObserved = true;
    if (this.findings.length < this.maximum) {
      this.findings.push(boundFindingEvidence(finding));
      return;
    }

    this.truncated = true;
    let lowest = this.findings.length - 1;
    for (let index = this.findings.length - 2; index >= 0; index -= 1) {
      if (
        SEVERITY_RANK[this.findings[index]?.severity ?? 'error'] <
        SEVERITY_RANK[this.findings[lowest]?.severity ?? 'error']
      ) {
        lowest = index;
      }
    }
    if (rank > SEVERITY_RANK[this.findings[lowest]?.severity ?? 'error']) {
      this.findings[lowest] = boundFindingEvidence(finding);
    }
  }

  addAll(findings: readonly Finding[]): void {
    for (const finding of findings) this.add(finding);
  }

  observeOmitted(count: number, severity: Severity): void {
    if (count <= 0) return;
    this.observedFindingsAtLeast += count;
    this.truncated = true;
    if (SEVERITY_RANK[severity] >= SEVERITY_RANK[this.failOn]) {
      this.failureObserved = true;
    }
  }

  matchLimit(severity: Severity): number {
    const rank = SEVERITY_RANK[severity];
    const freeSlots = this.maximum - this.findings.length;
    const replaceable = this.findings.filter(
      (finding) => SEVERITY_RANK[finding.severity] < rank,
    ).length;
    return Math.min(this.maximum + 1, Math.max(1, freeSlots + replaceable + 1));
  }
}

export async function scanArtifacts(input: ScanOptions): Promise<ScanResult> {
  const policy = validatePolicy(input.policy);
  const limits = resolveLimits(policy);
  const discovered = await discoverFiles(
    input.root,
    limits,
    policy.exclude ?? [],
    input.signal,
  );
  const failOn = policy.failOn ?? 'error';
  const collector = new FindingCollector(limits.maxFindings, failOn);
  collector.addAll(discovered.findings);
  collector.observeOmitted(
    discovered.findingsObserved - discovered.findings.length,
    'error',
  );
  if (discovered.findingsTruncated) collector.truncated = true;
  if (input.signal?.aborted)
    throw new SurfaceGuardError('SG_ABORTED', 'Artifact scan was aborted');

  const requestedAdapter = input.adapter ?? policy.adapter ?? 'auto';
  const adapter = selectAdapter(requestedAdapter, discovered.files);
  for (const file of discovered.files)
    file.kind = adapter.classify(file.relativePath) ?? 'unknown';

  const texts = new Map<string, string>();
  const textValidity = new Map<string, boolean>();
  const unsupportedTextArtifacts = new Set<string>();
  const encodingFindings = new Set<string>();
  let expandedBytes = 0;
  const recordInvalidEncoding = (file: ArtifactFile): void => {
    unsupportedTextArtifacts.add(file.relativePath);
    if (encodingFindings.has(file.relativePath)) return;
    encodingFindings.add(file.relativePath);
    collector.add(encodingFinding(file));
  };
  const readText = async (
    file: ArtifactFile,
    reportInvalidEncoding = true,
  ): Promise<string> => {
    const cached = texts.get(file.relativePath);
    if (cached !== undefined) {
      if (
        reportInvalidEncoding &&
        textValidity.get(file.relativePath) === false &&
        !encodingFindings.has(file.relativePath)
      ) {
        recordInvalidEncoding(file);
      }
      return cached;
    }
    let text: string;
    let valid: boolean;
    if (file.kind === 'sitemap' && file.relativePath.toLowerCase().endsWith('.gz')) {
      const remaining = limits.maxTotalBytes - expandedBytes;
      const expanded = await readGzipTextStreaming(
        file,
        Math.min(limits.maxFileBytes, remaining),
        input.signal,
      );
      text = expanded.text;
      valid = expanded.valid;
      expandedBytes += expanded.outputBytes;
    } else {
      const decoded = await readFileStreaming(file, limits, input.signal);
      text = decoded.text;
      valid = decoded.valid;
    }
    textValidity.set(file.relativePath, valid);
    if (reportInvalidEncoding && !valid && !encodingFindings.has(file.relativePath)) {
      recordInvalidEncoding(file);
    }
    if (file.kind === 'sitemap' || file.kind === 'robots') {
      texts.set(file.relativePath, text);
    }
    return text;
  };

  const routeResult = await adapter.collectRoutes({
    root: discovered.root,
    files: discovered.files,
    readText,
    limits,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const evaluatedRoutes = evaluateRoutes(
    routeResult.routes,
    { ...input, policy },
    limits.maxDecodePasses,
  );
  collector.addAll(routeResult.findings);
  collector.addAll(evaluatedRoutes.findings);
  const excludedFrameworkRoutes = frameworkErrorRoutes(
    adapter.name,
    routeResult.routes,
    limits.maxDecodePasses,
  );
  let filesScanned = 0;
  const unknownPatternRules = [
    ...(policy.forbidden?.text ?? []),
    ...(policy.forbidden?.endpoints ?? []),
  ].filter(
    (rule) =>
      !rule.scopes || rule.scopes.includes('all') || rule.scopes.includes('unknown'),
  );
  const requiresUnknownInspection =
    unknownPatternRules.length > 0 || policy.sourceMaps?.mode === 'forbid';
  const explicitUnknownInspection = unknownPatternRules.some((rule) =>
    rule.scopes?.includes('unknown'),
  );

  for (const file of discovered.files) {
    if (input.signal?.aborted)
      throw new SurfaceGuardError('SG_ABORTED', 'Artifact scan was aborted');
    for (const rule of policy.forbidden?.files ?? []) {
      if (matchesGlob(file.relativePath, rule.glob)) {
        collector.add({
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
      collector.add({
        ruleId: 'SG3001',
        severity: 'error',
        category: 'source-map',
        artifactPath: file.relativePath,
        message: 'Source map file is forbidden by policy',
        evidence: basename(file.relativePath),
      });
    }
    if (file.kind === 'unknown' && !requiresUnknownInspection) {
      continue;
    }
    if (
      file.kind === 'unknown' &&
      hasKnownBinaryExtension(file) &&
      !explicitUnknownInspection
    ) {
      continue;
    }

    const text = await readText(file, file.kind !== 'unknown');
    if (file.kind === 'unknown' && textValidity.get(file.relativePath) === false) {
      unsupportedTextArtifacts.add(file.relativePath);
      if (explicitUnknownInspection || ambiguousUnknownLooksTextual(text)) {
        recordInvalidEncoding(file);
      }
    }
    filesScanned += 1;

    if (policy.sourceMaps?.mode === 'forbid') {
      const directive = /[/#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/giu;
      const directiveLimit = collector.matchLimit('error');
      let directivesObserved = 0;
      let line = 1;
      let lineStart = 0;
      let locationCursor = 0;
      let match: RegExpExecArray | null;
      while ((match = directive.exec(text)) !== null) {
        const inline = match[1]?.startsWith('data:') ?? false;
        if (inline && policy.sourceMaps.inline === 'allow') continue;
        while (locationCursor < match.index) {
          const code = text.charCodeAt(locationCursor);
          if (code === 13) {
            if (
              text.charCodeAt(locationCursor + 1) === 10 &&
              locationCursor + 1 < match.index
            ) {
              locationCursor += 1;
            }
            line += 1;
            lineStart = locationCursor + 1;
          } else if (code === 10) {
            line += 1;
            lineStart = locationCursor + 1;
          }
          locationCursor += 1;
        }
        collector.add({
          ruleId: inline ? 'SG3002' : 'SG3003',
          severity: 'error',
          category: 'source-map',
          artifactPath: file.relativePath,
          message: inline
            ? 'Inline source map is forbidden by policy'
            : 'Source map reference is forbidden by policy',
          evidence: match[0],
          location: {
            line,
            column: match.index - lineStart + 1,
            offset: match.index,
          },
        });
        directivesObserved += 1;
        if (directivesObserved >= directiveLimit) break;
      }
    }

    const groups = [
      ['text', policy.forbidden?.text ?? []],
      ['endpoint', policy.forbidden?.endpoints ?? []],
      ['metadata', file.kind === 'metadata' ? (policy.forbidden?.metadata ?? []) : []],
    ] as const;
    for (const [category, rules] of groups) {
      for (const rule of rules) {
        const severity = rule.severity ?? 'error';
        collector.addAll(
          matchPatternRule(text, file, rule, category, {
            ...limits,
            maxFindings: collector.matchLimit(severity),
          }),
        );
      }
    }
  }

  for (const file of discovered.files.filter(
    (candidate) => candidate.kind === 'sitemap' || candidate.kind === 'robots',
  )) {
    if (!texts.has(file.relativePath)) await readText(file);
  }
  collector.addAll(
    evaluateSitemap(
      policy,
      discovered.files,
      texts,
      evaluatedRoutes.normalized,
      excludedFrameworkRoutes,
      limits,
      input.signal,
    ),
  );
  const sorted = sortFindings(collector.findings);
  const truncatedEvidence = sorted.filter((finding) => finding.evidenceTruncated).length;

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
      findingsTruncated: collector.truncated,
    },
    completeness: {
      textInspection: unsupportedTextArtifacts.size === 0 ? 'complete' : 'incomplete',
      findingDetails: collector.truncated ? 'truncated' : 'complete',
      findingLimit: limits.maxFindings,
      retainedFindings: sorted.length,
      observedFindingsAtLeast: collector.observedFindingsAtLeast,
      evidenceDetails: truncatedEvidence === 0 ? 'complete' : 'truncated',
      evidenceLimit: MAX_RETAINED_EVIDENCE_BYTES,
      truncatedEvidence,
      unsupportedTextArtifacts: unsupportedTextArtifacts.size,
    },
    failed: collector.failureObserved,
  };
}
