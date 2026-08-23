"use strict";

// src/action.ts
var import_promises3 = require("fs/promises");

// src/errors.ts
var SurfaceGuardError = class extends Error {
  code;
  details;
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SurfaceGuardError";
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details
    };
  }
};

// src/policy.ts
var import_promises = require("fs/promises");
var import_node_path = require("path");

// src/constants.ts
var VERSION = "0.1.1";
var DEFAULT_LIMITS = Object.freeze({
  maxFiles: 5e4,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFindings: 1e3,
  maxDecodePasses: 3,
  maxPatternLength: 1024
});

// src/policy.ts
var SEVERITIES = /* @__PURE__ */ new Set(["error", "warning", "note"]);
var ADAPTERS = /* @__PURE__ */ new Set(["auto", "generic", "nextjs"]);
var SCOPES = /* @__PURE__ */ new Set([
  "all",
  "route-manifest",
  "client-chunk",
  "server-bundle",
  "static-asset",
  "source-map",
  "sitemap",
  "robots",
  "metadata",
  "unknown"
]);
function record(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path} must be an object`, { path });
  }
  return value;
}
function strings(value, path) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path} must be an array of non-empty strings`,
      {
        path
      }
    );
  }
  return value;
}
function assertKnownKeys(value, keys, path) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path} contains unknown properties`,
      {
        path,
        unknown
      }
    );
  }
}
function validatePatternRule(value, path) {
  const item = record(value, path);
  assertKnownKeys(
    item,
    ["id", "pattern", "match", "caseSensitive", "severity", "scopes", "message"],
    path
  );
  if (typeof item.id !== "string" || !/^[a-z][a-z0-9._-]+$/u.test(item.id)) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.id has an invalid rule identifier`,
      { path }
    );
  }
  if (typeof item.pattern !== "string" || item.pattern.length === 0) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.pattern must be a non-empty string`,
      { path }
    );
  }
  if (item.match !== void 0 && item.match !== "literal" && item.match !== "regex") {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.match must be literal or regex`,
      { path }
    );
  }
  if (item.caseSensitive !== void 0 && typeof item.caseSensitive !== "boolean") {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.caseSensitive must be boolean`,
      { path }
    );
  }
  if (item.severity !== void 0 && !SEVERITIES.has(item.severity)) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path}.severity is invalid`, {
      path
    });
  }
  const scopes = strings(item.scopes, `${path}.scopes`);
  if (scopes?.some((scope) => !SCOPES.has(scope))) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.scopes contains an invalid scope`,
      { path }
    );
  }
  if (item.message !== void 0 && typeof item.message !== "string") {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path}.message must be a string`, {
      path
    });
  }
  return item;
}
function validateFileRule(value, path) {
  const item = record(value, path);
  assertKnownKeys(item, ["id", "glob", "severity", "message"], path);
  if (typeof item.id !== "string" || !/^[a-z][a-z0-9._-]+$/u.test(item.id)) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.id has an invalid rule identifier`,
      { path }
    );
  }
  if (typeof item.glob !== "string" || item.glob.length === 0) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.glob must be a non-empty string`,
      { path }
    );
  }
  if (item.severity !== void 0 && !SEVERITIES.has(item.severity)) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path}.severity is invalid`, {
      path
    });
  }
  return item;
}
function validatePatternRules(value, path) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path} must be an array`, { path });
  }
  return value.map((item, index) => validatePatternRule(item, `${path}[${index}]`));
}
function validateFileRules(value, path) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path} must be an array`, { path });
  }
  return value.map((item, index) => validateFileRule(item, `${path}[${index}]`));
}
function validatePolicy(value) {
  const root = record(value, "$");
  assertKnownKeys(
    root,
    [
      "schemaVersion",
      "adapter",
      "failOn",
      "exclude",
      "routes",
      "sourceMaps",
      "forbidden",
      "sitemap",
      "limits"
    ],
    "$"
  );
  if (root.schemaVersion !== 1) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", "schemaVersion must be 1", {
      path: "$.schemaVersion",
      received: root.schemaVersion
    });
  }
  if (root.adapter !== void 0 && (typeof root.adapter !== "string" || !ADAPTERS.has(root.adapter))) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      "adapter must be auto, generic, or nextjs",
      {
        path: "$.adapter"
      }
    );
  }
  if (root.failOn !== void 0 && !SEVERITIES.has(root.failOn)) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", "failOn is invalid", {
      path: "$.failOn"
    });
  }
  strings(root.exclude, "$.exclude");
  if (root.routes !== void 0) {
    const routes = record(root.routes, "$.routes");
    assertKnownKeys(routes, ["allow", "deny", "require"], "$.routes");
    strings(routes.allow, "$.routes.allow");
    strings(routes.deny, "$.routes.deny");
    strings(routes.require, "$.routes.require");
  }
  if (root.sourceMaps !== void 0) {
    const maps = record(root.sourceMaps, "$.sourceMaps");
    assertKnownKeys(maps, ["mode", "inline"], "$.sourceMaps");
    if (maps.mode !== "allow" && maps.mode !== "forbid") {
      throw new SurfaceGuardError(
        "SG_CONFIG_INVALID",
        "$.sourceMaps.mode must be allow or forbid"
      );
    }
    if (maps.inline !== void 0 && maps.inline !== "allow" && maps.inline !== "forbid") {
      throw new SurfaceGuardError(
        "SG_CONFIG_INVALID",
        "$.sourceMaps.inline must be allow or forbid"
      );
    }
  }
  if (root.forbidden !== void 0) {
    const forbidden = record(root.forbidden, "$.forbidden");
    assertKnownKeys(forbidden, ["text", "endpoints", "metadata", "files"], "$.forbidden");
    validatePatternRules(forbidden.text, "$.forbidden.text");
    validatePatternRules(forbidden.endpoints, "$.forbidden.endpoints");
    validatePatternRules(forbidden.metadata, "$.forbidden.metadata");
    validateFileRules(forbidden.files, "$.forbidden.files");
  }
  if (root.sitemap !== void 0) {
    const sitemap = record(root.sitemap, "$.sitemap");
    assertKnownKeys(
      sitemap,
      ["mode", "requireRobotsReference", "requireRoutes", "forbidDisallowedRoutes"],
      "$.sitemap"
    );
    if (sitemap.mode !== void 0 && (typeof sitemap.mode !== "string" || !["off", "if-present", "required"].includes(sitemap.mode))) {
      throw new SurfaceGuardError("SG_CONFIG_INVALID", "$.sitemap.mode is invalid");
    }
    for (const key of [
      "requireRobotsReference",
      "requireRoutes",
      "forbidDisallowedRoutes"
    ]) {
      if (sitemap[key] !== void 0 && typeof sitemap[key] !== "boolean") {
        throw new SurfaceGuardError(
          "SG_CONFIG_INVALID",
          `$.sitemap.${key} must be boolean`
        );
      }
    }
  }
  if (root.limits !== void 0) {
    const limits = record(root.limits, "$.limits");
    assertKnownKeys(limits, Object.keys(DEFAULT_LIMITS), "$.limits");
    for (const [key, value2] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value2) || value2 <= 0) {
        throw new SurfaceGuardError(
          "SG_CONFIG_INVALID",
          `$.limits.${key} must be a positive integer`
        );
      }
    }
  }
  return value;
}
async function loadPolicy(path) {
  const absolutePath = (0, import_node_path.resolve)(path);
  let source;
  try {
    source = await (0, import_promises.readFile)(absolutePath, "utf8");
  } catch (error) {
    throw new SurfaceGuardError("SG_IO_ERROR", `Unable to read policy: ${absolutePath}`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    return validatePolicy(JSON.parse(source));
  } catch (error) {
    if (error instanceof SurfaceGuardError) throw error;
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `Policy is not valid JSON: ${absolutePath}`,
      {
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
}
function resolveLimits(policy) {
  return { ...DEFAULT_LIMITS, ...policy.limits };
}

// src/reporters/markdown.ts
function table(value) {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}
function location(finding) {
  if (!finding.location) return finding.artifactPath;
  return `${finding.artifactPath}:${finding.location.line}:${finding.location.column}`;
}
function renderMarkdown(result) {
  const status = result.failed ? "failed" : "passed";
  const lines = [
    "# SurfaceGuard report",
    "",
    `Status: **${status}**`,
    "",
    `Adapter: \`${result.adapter}\``,
    "",
    `Scanned ${result.statistics.filesScanned} text artifacts (${result.statistics.bytesVisited} bytes) and discovered ${result.statistics.routesFound} routes.`,
    ""
  ];
  if (result.findings.length === 0) {
    lines.push("No findings.", "");
    return `${lines.join("\n")}
`;
  }
  lines.push("| Severity | Rule | Artifact | Evidence |", "| --- | --- | --- | --- |");
  for (const finding of result.findings) {
    lines.push(
      `| ${finding.severity} | ${table(finding.ruleId)} | ${table(location(finding))} | ${table(finding.evidence ?? finding.message)} |`
    );
  }
  lines.push("");
  return `${lines.join("\n")}
`;
}

// src/reporters/sarif.ts
var import_node_crypto = require("crypto");
function fingerprint(finding) {
  return (0, import_node_crypto.createHash)("sha256").update(
    [
      finding.ruleId,
      finding.artifactPath,
      finding.location?.offset ?? "",
      finding.evidence ?? ""
    ].join("\0")
  ).digest("hex");
}
function toSarif(result) {
  const ruleIds = [...new Set(result.findings.map((finding) => finding.ruleId))].sort();
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "SurfaceGuard",
            semanticVersion: result.tool.version,
            informationUri: "https://github.com/tovellan/surfaceguard",
            rules: ruleIds.map((ruleId) => ({ id: ruleId, name: ruleId }))
          }
        },
        results: result.findings.map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.severity === "error" ? "error" : finding.severity === "warning" ? "warning" : "note",
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.artifactPath },
                ...finding.location ? {
                  region: {
                    startLine: finding.location.line,
                    startColumn: finding.location.column
                  }
                } : {}
              }
            }
          ],
          partialFingerprints: { primaryLocationLineHash: fingerprint(finding) },
          properties: {
            category: finding.category,
            evidence: finding.evidence,
            transform: finding.transform
          }
        }))
      }
    ]
  };
}
function renderSarif(result) {
  return `${JSON.stringify(toSarif(result), null, 2)}
`;
}

// src/scan.ts
var import_node_path5 = require("path");

// src/adapters/generic.ts
var import_node_path2 = require("path");
var ROUTE_KEYS = /* @__PURE__ */ new Set(["page", "path", "pathname", "route"]);
function classifyGeneric(relativePath) {
  const lower = relativePath.toLowerCase();
  const name = (0, import_node_path2.basename)(lower);
  const extension = (0, import_node_path2.extname)(lower);
  if (name === "robots.txt") return "robots";
  if (/^sitemap(?:-[^/]*)?\.xml$/u.test(name) || name === "sitemap.xml.gz")
    return "sitemap";
  if (name.endsWith(".map") || name.endsWith(".map.json")) return "source-map";
  if (name.includes("routes-manifest") || name.includes("route-manifest") || name === "pages-manifest.json" || name === "app-paths-manifest.json" || name === "prerender-manifest.json") {
    return "route-manifest";
  }
  if (name === "manifest.json" || name.endsWith(".webmanifest") || extension === ".html") {
    return "metadata";
  }
  if (/\/(?:server|serverless)\//u.test(`/${lower}`) && [".js", ".cjs", ".mjs"].includes(extension)) {
    return "server-bundle";
  }
  if (/\/(?:static\/chunks|chunks|assets)\//u.test(`/${lower}`) && [".js", ".cjs", ".mjs"].includes(extension)) {
    return "client-chunk";
  }
  if ([".js", ".cjs", ".mjs", ".css", ".json", ".xml", ".txt", ".html", ".svg"].includes(
    extension
  )) {
    return "static-asset";
  }
  return "unknown";
}
function walkRoutes(value, artifactPath, pointer, routes, key) {
  if (typeof value === "string") {
    if (value.startsWith("/") && (key === void 0 || ROUTE_KEYS.has(key))) {
      routes.push({ route: value, artifactPath, pointer });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(
      (item, index) => walkRoutes(item, artifactPath, `${pointer}/${index}`, routes, key)
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value)) {
    walkRoutes(child, artifactPath, `${pointer}/${childKey}`, routes, childKey);
  }
}
var genericAdapter = {
  name: "generic",
  detect: () => 1,
  classify: classifyGeneric,
  async collectRoutes(context) {
    const routes = [];
    const findings = [];
    for (const file of context.files.filter(
      (candidate) => candidate.kind === "route-manifest"
    )) {
      try {
        const value = JSON.parse(await context.readText(file));
        walkRoutes(value, file.relativePath, "", routes);
      } catch (error) {
        findings.push({
          ruleId: "SG1004",
          severity: "error",
          category: "route",
          artifactPath: file.relativePath,
          message: "Route manifest is malformed or unreadable",
          evidence: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { routes, findings };
  }
};

// src/adapters/nextjs.ts
var import_node_path3 = require("path");
var NEXT_MANIFESTS = /* @__PURE__ */ new Set([
  "app-paths-manifest.json",
  "build-manifest.json",
  "pages-manifest.json",
  "prerender-manifest.json",
  "routes-manifest.json"
]);
function addRoute(routes, seen, route, file, pointer) {
  if (typeof route !== "string" || !route.startsWith("/")) return;
  const normalized = route.endsWith("/page") ? route.slice(0, -5) || "/" : route;
  const key = `${normalized}\0${file.relativePath}\0${pointer}`;
  if (seen.has(key)) return;
  seen.add(key);
  routes.push({ route: normalized, artifactPath: file.relativePath, pointer });
}
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function collectNextRoutes(value, file, routes) {
  const root = objectValue(value);
  if (!root) throw new TypeError("Manifest root must be an object");
  const seen = /* @__PURE__ */ new Set();
  const name = (0, import_node_path3.basename)(file.relativePath);
  if (name === "pages-manifest.json" || name === "app-paths-manifest.json") {
    Object.keys(root).forEach((route) => addRoute(routes, seen, route, file, `/${route}`));
    return;
  }
  if (name === "build-manifest.json") {
    const pages = objectValue(root.pages);
    Object.keys(pages ?? {}).forEach(
      (route) => addRoute(routes, seen, route, file, `/pages/${route}`)
    );
    return;
  }
  if (name === "prerender-manifest.json") {
    for (const section of ["routes", "dynamicRoutes"]) {
      const entries = objectValue(root[section]);
      Object.keys(entries ?? {}).forEach(
        (route) => addRoute(routes, seen, route, file, `/${section}/${route}`)
      );
    }
    return;
  }
  if (name === "routes-manifest.json") {
    for (const section of [
      "staticRoutes",
      "dynamicRoutes",
      "dataRoutes",
      "redirects",
      "rewrites"
    ]) {
      const entries = root[section];
      if (Array.isArray(entries)) {
        entries.forEach((entry, index) => {
          const candidate = objectValue(entry);
          addRoute(
            routes,
            seen,
            candidate?.page ?? candidate?.source ?? candidate?.pathname,
            file,
            `/${section}/${index}`
          );
        });
      } else if (section === "rewrites") {
        const groups = objectValue(entries);
        for (const [group, groupEntries] of Object.entries(groups ?? {})) {
          if (!Array.isArray(groupEntries)) continue;
          groupEntries.forEach((entry, index) => {
            const candidate = objectValue(entry);
            addRoute(routes, seen, candidate?.source, file, `/rewrites/${group}/${index}`);
          });
        }
      }
    }
  }
}
var nextjsAdapter = {
  name: "nextjs",
  detect(files) {
    return files.reduce((score, file) => {
      const name = (0, import_node_path3.basename)(file.relativePath);
      if (NEXT_MANIFESTS.has(name)) return score + 10;
      if (file.relativePath.includes("static/chunks/")) return score + 2;
      if (file.relativePath.includes("server/")) return score + 1;
      return score;
    }, 0);
  },
  classify(relativePath) {
    const name = (0, import_node_path3.basename)(relativePath);
    if (NEXT_MANIFESTS.has(name)) return "route-manifest";
    return classifyGeneric(relativePath);
  },
  async collectRoutes(context) {
    const routes = [];
    const findings = [];
    for (const file of context.files.filter(
      (candidate) => candidate.kind === "route-manifest" && NEXT_MANIFESTS.has((0, import_node_path3.basename)(candidate.relativePath))
    )) {
      try {
        collectNextRoutes(
          JSON.parse(await context.readText(file)),
          file,
          routes
        );
      } catch (error) {
        findings.push({
          ruleId: "SG1004",
          severity: "error",
          category: "route",
          artifactPath: file.relativePath,
          message: "Next.js route manifest is malformed or unreadable",
          evidence: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { routes, findings };
  }
};

// src/adapters/index.ts
var adapters = [nextjsAdapter, genericAdapter];
function selectAdapter(requested, files) {
  if (requested !== "auto") {
    const exact = adapters.find((adapter) => adapter.name === requested);
    if (!exact)
      throw new SurfaceGuardError("SG_CONFIG_INVALID", `Unknown adapter: ${requested}`);
    return exact;
  }
  return [...adapters].sort((left, right) => right.detect(files) - left.detect(files))[0] ?? genericAdapter;
}

// src/decode.ts
function identitySpans(text) {
  return Array.from(text, (_, index) => ({ start: index, end: index + 1 }));
}
function decodeHexEscapes(input2) {
  let output = "";
  const spans = [];
  let changed = false;
  for (let index = 0; index < input2.text.length; index += 1) {
    const short = /^\\x([0-9a-f]{2})/iu.exec(input2.text.slice(index));
    const long = /^\\u([0-9a-f]{4})/iu.exec(input2.text.slice(index));
    const match = long ?? short;
    if (match?.[1]) {
      const width = match[0].length;
      output += String.fromCodePoint(Number.parseInt(match[1], 16));
      const first = input2.spans[index];
      const last = input2.spans[index + width - 1];
      if (first && last) spans.push({ start: first.start, end: last.end });
      index += width - 1;
      changed = true;
      continue;
    }
    output += input2.text[index] ?? "";
    const span = input2.spans[index];
    if (span) spans.push(span);
  }
  return changed ? { text: output, spans, transform: `${input2.transform}+js-hex` } : void 0;
}
function decodePercent(input2) {
  let output = "";
  const spans = [];
  let changed = false;
  for (let index = 0; index < input2.text.length; index += 1) {
    const match = /^(?:%[0-9a-f]{2})+/iu.exec(input2.text.slice(index));
    if (!match) {
      output += input2.text[index] ?? "";
      const span = input2.spans[index];
      if (span) spans.push(span);
      continue;
    }
    const bytes = match[0].split("%").slice(1).map((value) => Number.parseInt(value, 16));
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      output += input2.text[index] ?? "";
      const span = input2.spans[index];
      if (span) spans.push(span);
      continue;
    }
    const first = input2.spans[index];
    const last = input2.spans[index + match[0].length - 1];
    if (!first || !last) continue;
    for (const character of decoded) {
      output += character;
      spans.push({ start: first.start, end: last.end });
    }
    index += match[0].length - 1;
    changed = true;
  }
  return changed ? { text: output, spans, transform: `${input2.transform}+percent` } : void 0;
}
function decodeTextVariants(text, maxPasses) {
  const original = { text, spans: identitySpans(text), transform: "raw" };
  const variants = [original];
  let current = decodeHexEscapes(original) ?? original;
  if (current !== original) variants.push(current);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const next = decodePercent(current);
    if (!next || next.text === current.text) break;
    variants.push(next);
    current = next;
    const withHex = decodeHexEscapes(current);
    if (withHex && withHex.text !== current.text) {
      variants.push(withHex);
      current = withHex;
    }
  }
  return variants;
}
function rawSpanForMatch(variant, start, length) {
  const first = variant.spans[start];
  const last = variant.spans[Math.max(start, start + length - 1)];
  return first && last ? { start: first.start, end: last.end } : void 0;
}
function repeatedlyDecodeUrl(value, maxPasses = 3) {
  let current = value;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}
function canonicalizeUrl(value, maxPasses = 3) {
  const decoded = repeatedlyDecodeUrl(value.trim(), maxPasses).replaceAll("\\", "/");
  const absolute = /^[a-z][a-z\d+.-]*:/iu.test(decoded);
  const url = new URL(decoded, "https://surfaceguard.invalid");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.protocol === "https:" && url.port === "443" || url.protocol === "http:" && url.port === "80") {
    url.port = "";
  }
  url.pathname = url.pathname.replace(/\/{2,}/gu, "/");
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}

// src/filesystem.ts
var import_node_fs = require("fs");
var import_promises2 = require("fs/promises");
var import_node_path4 = require("path");

// src/glob.ts
var REGEX_SPECIAL = /* @__PURE__ */ new Set(["\\", "^", "$", ".", "+", "(", ")", "|", "{", "}"]);
function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? "";
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end > index + 1) {
        const content = glob.slice(index + 1, end).replace(/^!/u, "^");
        source += `[${content.replaceAll("\\", "\\\\")}]`;
        index = end;
      } else {
        source += "\\[";
      }
    } else {
      source += REGEX_SPECIAL.has(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${source}$`, "u");
}
function matchesGlob(value, glob) {
  return globToRegExp(glob).test(value);
}

// src/filesystem.ts
function toPosixPath(value) {
  return value.split(import_node_path4.sep).join("/");
}
function isContained(root, candidate) {
  const child = (0, import_node_path4.relative)(root, candidate);
  return child === "" || !child.startsWith(`..${import_node_path4.sep}`) && child !== ".." && !(0, import_node_path4.isAbsolute)(child);
}
async function discoverFiles(inputRoot, limits, exclude) {
  const requestedRoot = (0, import_node_path4.resolve)(inputRoot);
  let rootStat;
  try {
    rootStat = await (0, import_promises2.lstat)(requestedRoot);
  } catch (error) {
    throw new SurfaceGuardError(
      "SG_ROOT_INVALID",
      `Artifact root does not exist: ${requestedRoot}`,
      {
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SurfaceGuardError(
      "SG_ROOT_INVALID",
      "Artifact root must be a real directory, not a symlink",
      {
        root: requestedRoot
      }
    );
  }
  const root = await (0, import_promises2.realpath)(requestedRoot);
  const files = [];
  const findings = [];
  let totalBytes = 0;
  async function visit(directory) {
    let handle;
    try {
      handle = await (0, import_promises2.opendir)(directory);
    } catch (error) {
      throw new SurfaceGuardError(
        "SG_IO_ERROR",
        `Unable to read artifact directory: ${directory}`,
        {
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }
    const entries = [];
    for await (const entry of handle) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = (0, import_node_path4.resolve)(directory, entry.name);
      const relativePath = toPosixPath((0, import_node_path4.relative)(root, absolutePath));
      if (!isContained(root, absolutePath)) {
        findings.push({
          ruleId: "SG1001",
          severity: "error",
          category: "filesystem",
          artifactPath: relativePath,
          message: "Artifact path escapes the scan root"
        });
        continue;
      }
      if (exclude.some((pattern) => matchesGlob(relativePath, pattern))) continue;
      const stat = await (0, import_promises2.lstat)(absolutePath);
      if (stat.isSymbolicLink()) {
        findings.push({
          ruleId: "SG1002",
          severity: "error",
          category: "filesystem",
          artifactPath: relativePath,
          message: "Symbolic links are not followed inside artifact roots",
          evidence: relativePath,
          help: "Copy the intended artifact into the build directory as a regular file."
        });
        continue;
      }
      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (files.length + 1 > limits.maxFiles) {
        throw new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Artifact file count exceeds maxFiles",
          {
            limit: limits.maxFiles
          }
        );
      }
      totalBytes += stat.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Artifact bytes exceed maxTotalBytes",
          {
            limit: limits.maxTotalBytes,
            observed: totalBytes
          }
        );
      }
      files.push({
        absolutePath,
        relativePath,
        kind: "unknown",
        size: stat.size
      });
    }
  }
  await visit(root);
  return { root, files, findings };
}
async function readFileStreaming(file, limits, signal) {
  if (file.size > limits.maxFileBytes) {
    throw new SurfaceGuardError("SG_RESOURCE_LIMIT", "Artifact file exceeds maxFileBytes", {
      artifactPath: file.relativePath,
      limit: limits.maxFileBytes,
      observed: file.size
    });
  }
  const chunks = [];
  let observed = 0;
  const stream = (0, import_node_fs.createReadStream)(file.absolutePath, { highWaterMark: 64 * 1024, signal });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observed += buffer.byteLength;
      if (observed > limits.maxFileBytes) {
        stream.destroy();
        throw new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Artifact grew beyond maxFileBytes while reading",
          {
            artifactPath: file.relativePath,
            limit: limits.maxFileBytes
          }
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof SurfaceGuardError) throw error;
    if (signal?.aborted) {
      throw new SurfaceGuardError("SG_ABORTED", "Artifact scan was aborted");
    }
    throw new SurfaceGuardError(
      "SG_IO_ERROR",
      `Unable to read artifact: ${file.relativePath}`,
      {
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}
function appearsBinary(text) {
  const sample = text.slice(0, 8192);
  if (sample.includes("\0")) return true;
  let controls = 0;
  for (const character of sample) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 9 || code > 13 && code < 32) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.05;
}

// src/matcher.ts
function locationAt(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1, offset };
}
function safeRegex(rule, limits) {
  if (rule.pattern.length > limits.maxPatternLength) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `Pattern ${rule.id} exceeds maxPatternLength`,
      {
        ruleId: rule.id,
        limit: limits.maxPatternLength
      }
    );
  }
  if (/\([^)]*[+*][^)]*\)[+*{]/u.test(rule.pattern)) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `Pattern ${rule.id} contains a nested quantifier`,
      {
        ruleId: rule.id
      }
    );
  }
  try {
    return new RegExp(rule.pattern, rule.caseSensitive === false ? "gui" : "gu");
  } catch (error) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `Pattern ${rule.id} is not a valid regular expression`,
      {
        ruleId: rule.id,
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
}
function literalMatches(text, pattern, caseSensitive) {
  const haystack = caseSensitive ? text : text.toLocaleLowerCase("en-US");
  const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase("en-US");
  const matches = [];
  let offset = 0;
  while (needle.length > 0) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    matches.push([index, needle.length]);
    offset = index + Math.max(1, needle.length);
  }
  return matches;
}
function matchPatternRule(raw, file, rule, category, limits) {
  if (rule.scopes && !rule.scopes.includes("all") && !rule.scopes.includes(file.kind))
    return [];
  if (rule.pattern.length > limits.maxPatternLength) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `Pattern ${rule.id} exceeds maxPatternLength`,
      {
        ruleId: rule.id
      }
    );
  }
  const variants = decodeTextVariants(raw, limits.maxDecodePasses);
  const findings = [];
  const seen = /* @__PURE__ */ new Set();
  const regex = rule.match === "regex" ? safeRegex(rule, limits) : void 0;
  for (const variant of variants) {
    const matches = [];
    if (regex) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(variant.text)) !== null) {
        matches.push([match.index, match[0].length]);
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    } else {
      matches.push(
        ...literalMatches(variant.text, rule.pattern, rule.caseSensitive !== false)
      );
    }
    for (const [start, length] of matches) {
      const span = rawSpanForMatch(variant, start, Math.max(1, length));
      if (!span) continue;
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const evidence = raw.slice(span.start, span.end);
      findings.push({
        ruleId: rule.id,
        severity: rule.severity ?? "error",
        category,
        artifactPath: file.relativePath,
        message: rule.message ?? `Forbidden ${category} pattern matched`,
        evidence,
        location: locationAt(raw, span.start),
        transform: variant.transform,
        help: `Remove the matched material from the produced ${file.kind} artifact or narrow the policy deliberately.`
      });
    }
  }
  return findings;
}

// src/sitemap.ts
function decodeXml(value) {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'"
  };
  return value.replace(
    /&(amp|lt|gt|quot|apos);/gu,
    (_match, name) => {
      return entities[name];
    }
  );
}
function parseSitemap(text, maxDecodePasses) {
  const routes = [];
  const expression = /<loc\b[^>]*>([\s\S]*?)<\/loc>/giu;
  let match;
  while ((match = expression.exec(text)) !== null) {
    const value = decodeXml(match[1]?.trim() ?? "");
    if (!value) continue;
    try {
      const canonical = canonicalizeUrl(value, maxDecodePasses);
      const url = new URL(canonical, "https://surfaceguard.invalid");
      routes.push(`${url.pathname}${url.search}`);
    } catch {
      continue;
    }
  }
  return routes;
}
function parseRobots(text) {
  const rules = { disallow: [], sitemaps: [] };
  for (const line of text.split(/\r?\n/u)) {
    const withoutComment = line.split("#", 1)[0]?.trim() ?? "";
    const separator = withoutComment.indexOf(":");
    if (separator < 0) continue;
    const name = withoutComment.slice(0, separator).trim().toLowerCase();
    const value = withoutComment.slice(separator + 1).trim();
    if (name === "disallow" && value.startsWith("/")) rules.disallow.push(value);
    if (name === "sitemap" && value) rules.sitemaps.push(value);
  }
  return rules;
}

// src/scan.ts
var SEVERITY_RANK = {
  note: 0,
  warning: 1,
  error: 2
};
function routeMatches(route, patterns) {
  return patterns.some((pattern) => matchesGlob(route, pattern));
}
function normalizeRoute(value, maxDecodePasses) {
  try {
    return canonicalizeUrl(value, maxDecodePasses).split("?", 1)[0] ?? "/";
  } catch {
    return value;
  }
}
function evaluateRoutes(routes, options, maxDecodePasses) {
  const findings = [];
  const normalized = /* @__PURE__ */ new Map();
  for (const evidence of routes) {
    const route = normalizeRoute(evidence.route, maxDecodePasses);
    if (!normalized.has(route)) normalized.set(route, evidence);
  }
  const assertions = options.policy.routes;
  if (!assertions) return { findings, normalized };
  for (const [route, evidence] of normalized) {
    if (assertions.allow?.length && !routeMatches(route, assertions.allow)) {
      findings.push({
        ruleId: "SG2001",
        severity: "error",
        category: "route",
        artifactPath: evidence.artifactPath,
        message: "Produced route is outside the route allow list",
        evidence: route,
        help: "Remove the route from the public build or add a deliberate allow assertion."
      });
    }
    if (assertions.deny?.length && routeMatches(route, assertions.deny)) {
      findings.push({
        ruleId: "SG2002",
        severity: "error",
        category: "route",
        artifactPath: evidence.artifactPath,
        message: "Produced route matches a route deny assertion",
        evidence: route,
        help: "Remove the route from the produced artifact."
      });
    }
  }
  for (const required of assertions.require ?? []) {
    if (![...normalized.keys()].some((route) => matchesGlob(route, required))) {
      findings.push({
        ruleId: "SG2003",
        severity: "error",
        category: "route",
        artifactPath: ".",
        message: "Required route assertion was not satisfied",
        evidence: required,
        help: "Confirm that the intended public route is present in the produced route manifests."
      });
    }
  }
  return { findings, normalized };
}
function evaluateSitemap(policy, files, texts, routes, maxDecodePasses) {
  const settings = policy.sitemap;
  if (!settings || settings.mode === "off") return [];
  const findings = [];
  const sitemapFiles = files.filter((file) => file.kind === "sitemap");
  const robotsFile = files.find((file) => file.kind === "robots");
  if (settings.mode === "required" && sitemapFiles.length === 0) {
    findings.push({
      ruleId: "SG4001",
      severity: "error",
      category: "sitemap",
      artifactPath: ".",
      message: "A sitemap is required but no sitemap artifact was found"
    });
    return findings;
  }
  if (sitemapFiles.length === 0) return findings;
  const sitemapRoutes = /* @__PURE__ */ new Map();
  for (const file of sitemapFiles) {
    const text = texts.get(file.relativePath) ?? "";
    for (const route of parseSitemap(text, maxDecodePasses)) {
      sitemapRoutes.set(normalizeRoute(route, maxDecodePasses), file.relativePath);
    }
  }
  const robots = robotsFile ? parseRobots(texts.get(robotsFile.relativePath) ?? "") : void 0;
  if (settings.requireRobotsReference) {
    if (!robotsFile || !robots || robots.sitemaps.length === 0) {
      findings.push({
        ruleId: "SG4002",
        severity: "error",
        category: "sitemap",
        artifactPath: robotsFile?.relativePath ?? ".",
        message: "robots.txt does not reference a sitemap"
      });
    }
  }
  for (const [route, artifactPath] of sitemapRoutes) {
    if (robots?.disallow.some((pattern) => routeMatches(route, [pattern, `${pattern}/**`]))) {
      findings.push({
        ruleId: "SG4003",
        severity: "error",
        category: "sitemap",
        artifactPath,
        message: "Sitemap exposes a route disallowed by robots.txt",
        evidence: route
      });
    }
    if (settings.forbidDisallowedRoutes && policy.routes?.deny?.length && routeMatches(route, policy.routes.deny)) {
      findings.push({
        ruleId: "SG4004",
        severity: "error",
        category: "sitemap",
        artifactPath,
        message: "Sitemap exposes a route denied by policy",
        evidence: route
      });
    }
    if (routes.size > 0 && !routes.has(route)) {
      findings.push({
        ruleId: "SG4005",
        severity: "warning",
        category: "sitemap",
        artifactPath,
        message: "Sitemap route was not found in produced route manifests",
        evidence: route
      });
    }
  }
  if (settings.requireRoutes) {
    for (const [route, evidence] of routes) {
      if (route.includes("[") || route.startsWith("/api/") || route.startsWith("/_"))
        continue;
      if (!sitemapRoutes.has(route)) {
        findings.push({
          ruleId: "SG4006",
          severity: "error",
          category: "sitemap",
          artifactPath: evidence.artifactPath,
          message: "Produced public route is missing from the sitemap",
          evidence: route
        });
      }
    }
  }
  return findings;
}
function sortFindings(findings) {
  return findings.sort(
    (left, right) => left.artifactPath.localeCompare(right.artifactPath) || (left.location?.offset ?? -1) - (right.location?.offset ?? -1) || left.ruleId.localeCompare(right.ruleId) || (left.evidence ?? "").localeCompare(right.evidence ?? "")
  );
}
async function scanArtifacts(input2) {
  const policy = validatePolicy(input2.policy);
  const limits = resolveLimits(policy);
  const discovered = await discoverFiles(input2.root, limits, policy.exclude ?? []);
  if (input2.signal?.aborted)
    throw new SurfaceGuardError("SG_ABORTED", "Artifact scan was aborted");
  const requestedAdapter = input2.adapter ?? policy.adapter ?? "auto";
  const adapter = selectAdapter(requestedAdapter, discovered.files);
  for (const file of discovered.files)
    file.kind = adapter.classify(file.relativePath) ?? "unknown";
  const texts = /* @__PURE__ */ new Map();
  const readText = async (file) => {
    const cached = texts.get(file.relativePath);
    if (cached !== void 0) return cached;
    const text = await readFileStreaming(file, limits, input2.signal);
    texts.set(file.relativePath, text);
    return text;
  };
  const routeResult = await adapter.collectRoutes({
    root: discovered.root,
    files: discovered.files,
    readText
  });
  const evaluatedRoutes = evaluateRoutes(
    routeResult.routes,
    { ...input2, policy },
    limits.maxDecodePasses
  );
  const findings = [
    ...discovered.findings,
    ...routeResult.findings,
    ...evaluatedRoutes.findings
  ];
  let filesScanned = 0;
  for (const file of discovered.files) {
    if (input2.signal?.aborted)
      throw new SurfaceGuardError("SG_ABORTED", "Artifact scan was aborted");
    for (const rule of policy.forbidden?.files ?? []) {
      if (matchesGlob(file.relativePath, rule.glob)) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity ?? "error",
          category: "file",
          artifactPath: file.relativePath,
          message: rule.message ?? "Forbidden artifact file pattern matched",
          evidence: file.relativePath,
          help: "Remove the file from the produced public artifact."
        });
      }
    }
    if (file.kind === "source-map" && policy.sourceMaps?.mode === "forbid") {
      findings.push({
        ruleId: "SG3001",
        severity: "error",
        category: "source-map",
        artifactPath: file.relativePath,
        message: "Source map file is forbidden by policy",
        evidence: (0, import_node_path5.basename)(file.relativePath)
      });
    }
    if (file.kind === "unknown") continue;
    const text = await readText(file);
    if (appearsBinary(text)) continue;
    filesScanned += 1;
    if (policy.sourceMaps?.mode === "forbid") {
      const directive = /[/#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/giu;
      let match;
      while ((match = directive.exec(text)) !== null) {
        const inline = match[1]?.startsWith("data:") ?? false;
        if (inline && policy.sourceMaps.inline === "allow") continue;
        findings.push({
          ruleId: inline ? "SG3002" : "SG3003",
          severity: "error",
          category: "source-map",
          artifactPath: file.relativePath,
          message: inline ? "Inline source map is forbidden by policy" : "Source map reference is forbidden by policy",
          evidence: match[0],
          location: {
            line: text.slice(0, match.index).split("\n").length,
            column: match.index - text.lastIndexOf("\n", match.index - 1),
            offset: match.index
          }
        });
      }
    }
    const groups = [
      ["text", policy.forbidden?.text ?? []],
      ["endpoint", policy.forbidden?.endpoints ?? []],
      ["metadata", file.kind === "metadata" ? policy.forbidden?.metadata ?? [] : []]
    ];
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
    (candidate) => candidate.kind === "sitemap" || candidate.kind === "robots"
  )) {
    if (!texts.has(file.relativePath)) await readText(file);
  }
  findings.push(
    ...evaluateSitemap(
      policy,
      discovered.files,
      texts,
      evaluatedRoutes.normalized,
      limits.maxDecodePasses
    )
  );
  if (findings.length > limits.maxFindings) findings.length = limits.maxFindings;
  const sorted = sortFindings(findings);
  const failOn = policy.failOn ?? "error";
  return {
    schemaVersion: 1,
    tool: { name: "surfaceguard", version: VERSION },
    root: ".",
    adapter: adapter.name,
    findings: sorted,
    statistics: {
      filesVisited: discovered.files.length,
      filesScanned,
      bytesVisited: discovered.files.reduce((total, file) => total + file.size, 0),
      routesFound: evaluatedRoutes.normalized.size
    },
    failed: sorted.some(
      (finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[failOn]
    )
  };
}

// src/action.ts
function input(name, required = false) {
  const key = `INPUT_${name.toUpperCase().replaceAll(" ", "_")}`;
  const value = process.env[key]?.trim() ?? "";
  if (required && !value) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `Action input ${name} is required`);
  }
  return value;
}
function commandData(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
function commandProperty(value) {
  return commandData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}
function annotation(finding) {
  const level = finding.severity === "error" ? "error" : finding.severity === "warning" ? "warning" : "notice";
  const properties = [
    `title=${commandProperty(`${finding.ruleId}: ${finding.message}`)}`,
    `file=${commandProperty(finding.artifactPath)}`
  ];
  if (finding.location) {
    properties.push(`line=${finding.location.line}`, `col=${finding.location.column}`);
  }
  process.stdout.write(
    `::${level} ${properties.join(",")}::${commandData(finding.evidence ?? finding.message)}
`
  );
}
async function setOutput(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (path) await (0, import_promises3.appendFile)(path, `${name}=${value}
`, "utf8");
  else
    process.stdout.write(
      `::set-output name=${commandProperty(name)}::${commandData(value)}
`
    );
}
async function run() {
  const root = input("artifact", true);
  const policyPath = input("policy", true);
  const adapterValue = input("adapter") || "auto";
  if (adapterValue !== "auto" && adapterValue !== "generic" && adapterValue !== "nextjs") {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `Unsupported adapter: ${adapterValue}`
    );
  }
  const sarifPath = input("sarif");
  const policy = await loadPolicy(policyPath);
  const result = await scanArtifacts({ root, policy, adapter: adapterValue });
  if (sarifPath) await (0, import_promises3.writeFile)(sarifPath, renderSarif(result), "utf8");
  await setOutput("findings", result.findings.length.toString());
  await setOutput("failed", String(result.failed));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await (0, import_promises3.appendFile)(summaryPath, renderMarkdown(result), "utf8");
  result.findings.forEach(annotation);
  if (result.failed) {
    throw new SurfaceGuardError(
      "SG_IO_ERROR",
      `SurfaceGuard found ${result.findings.length} policy finding(s).`
    );
  }
}
run().catch((error) => {
  const message = error instanceof SurfaceGuardError ? JSON.stringify(error.toJSON()) : error instanceof Error ? error.message : String(error);
  process.stdout.write(`::error::${commandData(message)}
`);
  process.exitCode = 1;
});
