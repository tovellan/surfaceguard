type Severity = 'error' | 'warning' | 'note';
type ArtifactKind = 'route-manifest' | 'client-chunk' | 'server-bundle' | 'static-asset' | 'source-map' | 'sitemap' | 'robots' | 'metadata' | 'unknown';
type RuleScope = ArtifactKind | 'all';
interface PatternRule {
    id: string;
    pattern: string;
    match?: 'literal' | 'regex';
    caseSensitive?: boolean;
    severity?: Severity;
    scopes?: RuleScope[];
    message?: string;
}
interface FileRule {
    id: string;
    glob: string;
    severity?: Severity;
    message?: string;
}
interface SurfaceGuardPolicyV1 {
    schemaVersion: 1;
    adapter?: 'auto' | 'generic' | 'nextjs' | 'vite';
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
type SurfaceGuardPolicy = SurfaceGuardPolicyV1;
interface ScanLimits {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxFindings: number;
    maxDecodePasses: number;
    maxPatternLength: number;
}
interface ArtifactFile {
    absolutePath: string;
    relativePath: string;
    kind: ArtifactKind;
    size: number;
}
interface RouteEvidence {
    route: string;
    artifactPath: string;
    pointer: string;
}
interface FindingLocation {
    line: number;
    column: number;
    offset: number;
}
interface Finding {
    ruleId: string;
    severity: Severity;
    category: 'policy' | 'route' | 'text' | 'endpoint' | 'metadata' | 'file' | 'source-map' | 'sitemap' | 'resource' | 'filesystem';
    artifactPath: string;
    message: string;
    evidence?: string;
    location?: FindingLocation;
    help?: string;
    transform?: string;
}
interface ScanStatistics {
    filesVisited: number;
    filesScanned: number;
    bytesVisited: number;
    routesFound: number;
}
interface ScanResult {
    schemaVersion: 1;
    tool: {
        name: 'surfaceguard';
        version: string;
    };
    root: string;
    adapter: string;
    findings: Finding[];
    statistics: ScanStatistics;
    failed: boolean;
}
interface ScanOptions {
    root: string;
    policy: SurfaceGuardPolicy;
    adapter?: 'auto' | 'generic' | 'nextjs' | 'vite';
    signal?: AbortSignal;
}
interface AdapterContext {
    root: string;
    files: readonly ArtifactFile[];
    readText(file: ArtifactFile): Promise<string>;
}
interface FrameworkAdapter {
    readonly name: string;
    detect(files: readonly ArtifactFile[]): number;
    classify(relativePath: string): ArtifactKind | undefined;
    collectRoutes(context: AdapterContext): Promise<{
        routes: RouteEvidence[];
        findings: Finding[];
    }>;
}

declare const genericAdapter: FrameworkAdapter;

declare const nextjsAdapter: FrameworkAdapter;

declare const viteAdapter: FrameworkAdapter;

declare const adapters: readonly FrameworkAdapter[];

declare const VERSION = "0.3.0";
declare const DEFAULT_LIMITS: Readonly<ScanLimits>;

interface SourceSpan {
    start: number;
    end: number;
}
interface DecodedText {
    text: string;
    spans: SourceSpan[];
    transform: string;
}
declare function decodeTextVariants(text: string, maxPasses: number): DecodedText[];
declare function repeatedlyDecodeUrl(value: string, maxPasses?: number): string;
declare function canonicalizeUrl(value: string, maxPasses?: number): string;

type SurfaceGuardErrorCode = 'SG_CONFIG_INVALID' | 'SG_ROOT_INVALID' | 'SG_RESOURCE_LIMIT' | 'SG_ABORTED' | 'SG_IO_ERROR';
declare class SurfaceGuardError extends Error {
    readonly code: SurfaceGuardErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    constructor(code: SurfaceGuardErrorCode, message: string, details?: Readonly<Record<string, unknown>>);
    toJSON(): Record<string, unknown>;
}

declare function globToRegExp(glob: string): RegExp;
declare function matchesGlob(value: string, glob: string): boolean;

declare function validatePolicy(value: unknown): SurfaceGuardPolicy;
declare function loadPolicy(path: string): Promise<SurfaceGuardPolicy>;
declare function resolveLimits(policy: SurfaceGuardPolicy): ScanLimits;

declare function renderJson(result: ScanResult): string;

declare function renderMarkdown(result: ScanResult): string;

declare function toSarif(result: ScanResult): Record<string, unknown>;
declare function renderSarif(result: ScanResult): string;

declare function scanArtifacts(input: ScanOptions): Promise<ScanResult>;

export { type AdapterContext, type ArtifactFile, type ArtifactKind, DEFAULT_LIMITS, type FileRule, type Finding, type FrameworkAdapter, type PatternRule, type RouteEvidence, type ScanLimits, type ScanOptions, type ScanResult, type Severity, SurfaceGuardError, type SurfaceGuardPolicy, type SurfaceGuardPolicyV1, VERSION, adapters, canonicalizeUrl, decodeTextVariants, genericAdapter, globToRegExp, loadPolicy, matchesGlob, nextjsAdapter, renderJson, renderMarkdown, renderSarif, repeatedlyDecodeUrl, resolveLimits, scanArtifacts, toSarif, validatePolicy, viteAdapter };
