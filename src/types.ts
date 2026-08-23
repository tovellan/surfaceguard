export type Severity = 'error' | 'warning' | 'note';

export type ArtifactKind =
  | 'route-manifest'
  | 'client-chunk'
  | 'server-bundle'
  | 'static-asset'
  | 'source-map'
  | 'sitemap'
  | 'robots'
  | 'metadata'
  | 'unknown';

export type RuleScope = ArtifactKind | 'all';

export interface PatternRule {
  id: string;
  pattern: string;
  match?: 'literal' | 'regex';
  caseSensitive?: boolean;
  severity?: Severity;
  scopes?: RuleScope[];
  message?: string;
}

export interface FileRule {
  id: string;
  glob: string;
  severity?: Severity;
  message?: string;
}

export interface SurfaceGuardPolicyV1 {
  schemaVersion: 1;
  adapter?: 'auto' | 'astro' | 'generic' | 'nextjs' | 'vite';
  failOn?: Severity;
  exclude?: string[];
  routes?: {
    allow?: string[];
    deny?: string[];
    require?: string[];
  };
  sourceMaps?: {
    mode: 'allow' | 'forbid';
    inline?: 'allow' | 'forbid';
  };
  forbidden?: {
    text?: PatternRule[];
    endpoints?: PatternRule[];
    metadata?: PatternRule[];
    files?: FileRule[];
  };
  sitemap?: {
    mode?: 'off' | 'if-present' | 'required';
    requireRobotsReference?: boolean;
    requireRoutes?: boolean;
    forbidDisallowedRoutes?: boolean;
  };
  limits?: Partial<ScanLimits>;
}

export type SurfaceGuardPolicy = SurfaceGuardPolicyV1;

export interface ScanLimits {
  maxEntries: number;
  maxDirectories: number;
  maxDepth: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxRoutes: number;
  maxManifestEntries: number;
  maxSitemapEntries: number;
  maxRobotsRules?: number;
  maxRobotsComparisons?: number;
  maxRobotsWork?: number;
  maxFindings: number;
  maxDecodePasses: number;
  maxPatternLength: number;
}

export interface ArtifactFile {
  absolutePath: string;
  relativePath: string;
  kind: ArtifactKind;
  size: number;
  identity?: {
    device: number;
    inode: number;
    modifiedMilliseconds: number;
    changedMilliseconds: number;
  };
}

export interface RouteEvidence {
  route: string;
  artifactPath: string;
  pointer: string;
  routeKind?: 'url' | 'artifact-path';
}

export interface FindingLocation {
  line: number;
  column: number;
  offset: number;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  category:
    | 'policy'
    | 'route'
    | 'text'
    | 'endpoint'
    | 'metadata'
    | 'file'
    | 'source-map'
    | 'sitemap'
    | 'resource'
    | 'filesystem';
  artifactPath: string;
  message: string;
  evidence?: string;
  evidenceTruncated?: boolean;
  evidenceBytes?: number;
  evidenceSha256?: string;
  location?: FindingLocation;
  help?: string;
  transform?: string;
}

export interface ScanStatistics {
  filesVisited: number;
  filesScanned: number;
  bytesVisited: number;
  routesFound: number;
  findingsTruncated: boolean;
}

export interface ScanCompleteness {
  textInspection: 'complete' | 'incomplete';
  findingDetails: 'complete' | 'truncated';
  findingLimit: number;
  retainedFindings: number;
  observedFindingsAtLeast: number;
  evidenceDetails?: 'complete' | 'truncated';
  evidenceLimit?: number;
  truncatedEvidence?: number;
  unsupportedTextArtifacts: number;
}

export interface ScanResult {
  schemaVersion: 1;
  tool: {
    name: 'surfaceguard';
    version: string;
  };
  root: string;
  adapter: string;
  findings: Finding[];
  statistics: ScanStatistics;
  completeness: ScanCompleteness;
  failed: boolean;
}

export interface ScanOptions {
  root: string;
  policy: SurfaceGuardPolicy;
  adapter?: 'auto' | 'astro' | 'generic' | 'nextjs' | 'vite';
  signal?: AbortSignal;
}

export interface AdapterContext {
  root: string;
  files: readonly ArtifactFile[];
  readText(file: ArtifactFile): Promise<string>;
  limits: Readonly<ScanLimits>;
  signal?: AbortSignal;
}

export interface FrameworkAdapter {
  readonly name: string;
  detect(files: readonly ArtifactFile[]): number;
  classify(relativePath: string): ArtifactKind | undefined;
  collectRoutes(context: AdapterContext): Promise<{
    routes: RouteEvidence[];
    findings: Finding[];
  }>;
}
