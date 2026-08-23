"use strict";

// src/action.ts
var import_promises3 = require("fs/promises");

// src/output-safety.ts
var import_node_crypto = require("crypto");
var MAX_RETAINED_EVIDENCE_BYTES = 2048;
var MAX_RETAINED_MESSAGE_BYTES = 2048;
var MAX_RETAINED_RULE_ID_BYTES = 255;
var MAX_MARKDOWN_REPORT_BYTES = 900 * 1024;
var BIDI_CONTROLS = /* @__PURE__ */ new Set([
  1564,
  8206,
  8207,
  8234,
  8235,
  8236,
  8237,
  8238,
  8294,
  8295,
  8296,
  8297
]);
function visibleEscape(codePoint) {
  if (codePoint === 9) return "\\t";
  if (codePoint === 10) return "\\n";
  if (codePoint === 13) return "\\r";
  return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, "0")}}`;
}
function printableText(value) {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint >= 127 && codePoint <= 159 || codePoint === 8232 || codePoint === 8233 || BIDI_CONTROLS.has(codePoint)) {
      output += visibleEscape(codePoint);
    } else {
      output += character;
    }
  }
  return output;
}
function isAsciiPunctuation(codePoint) {
  return codePoint >= 33 && codePoint <= 47 || codePoint >= 58 && codePoint <= 64 || codePoint >= 91 && codePoint <= 96 || codePoint >= 123 && codePoint <= 126;
}
function markdownCell(value) {
  let output = "";
  for (const character of printableText(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    output += isAsciiPunctuation(codePoint) ? `&#x${codePoint.toString(16).toUpperCase()};` : character;
  }
  return output;
}
function utf8Prefix(value, maximumBytes) {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maximumBytes) break;
    bytes += width;
    end += character.length;
  }
  return value.slice(0, end);
}
function boundOutputText(value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const digest = (0, import_node_crypto.createHash)("sha256").update(value).digest("hex");
  const suffix = ` ... [truncated sha256:${digest}]`;
  const prefixBytes = Math.max(0, maximumBytes - Buffer.byteLength(suffix, "utf8"));
  return `${utf8Prefix(value, prefixBytes)}${suffix}`;
}
function boundFindingEvidence(finding) {
  const ruleId = boundOutputText(finding.ruleId, MAX_RETAINED_RULE_ID_BYTES);
  const message = boundOutputText(finding.message, MAX_RETAINED_MESSAGE_BYTES);
  const bounded = ruleId === finding.ruleId && message === finding.message ? finding : { ...finding, ruleId, message };
  if (bounded.evidence === void 0) return bounded;
  const evidenceBytes = Buffer.byteLength(bounded.evidence, "utf8");
  if (evidenceBytes <= MAX_RETAINED_EVIDENCE_BYTES) return bounded;
  return {
    ...bounded,
    evidence: utf8Prefix(bounded.evidence, MAX_RETAINED_EVIDENCE_BYTES),
    evidenceTruncated: true,
    evidenceBytes: bounded.evidenceBytes ?? evidenceBytes,
    evidenceSha256: bounded.evidenceSha256 ?? (0, import_node_crypto.createHash)("sha256").update(bounded.evidence).digest("hex")
  };
}
function displayEvidence(finding) {
  const bounded = boundFindingEvidence(finding);
  const value = bounded.evidence ?? bounded.message;
  return bounded.evidenceTruncated ? `${value} ... [truncated from ${bounded.evidenceBytes ?? "unknown"} UTF-8 bytes]` : value;
}
function encodeUriSegment(segment) {
  let output = "";
  for (const byte of Buffer.from(segment, "utf8")) {
    const unreserved2 = byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte === 45 || byte === 46 || byte === 95 || byte === 126;
    output += unreserved2 ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return output;
}
function relativeSarifUri(artifactPath) {
  const encoded = artifactPath.split("/").map(encodeUriSegment).join("/");
  if (!encoded) return "./";
  return encoded.startsWith("/") ? `.${encoded}` : encoded;
}

// src/action-output.ts
var MAX_ANNOTATIONS_PER_LEVEL = 10;
function annotationLevel(finding) {
  return finding.severity === "error" ? "error" : finding.severity === "warning" ? "warning" : "notice";
}
function commandData(value) {
  return printableText(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
function commandProperty(value) {
  return commandData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}
function annotationCommand(finding) {
  const bounded = boundFindingEvidence(finding);
  const level = annotationLevel(bounded);
  const properties = [
    `title=${commandProperty(bounded.ruleId)}`,
    `file=${commandProperty(bounded.artifactPath)}`
  ];
  if (bounded.location) {
    properties.push(`line=${bounded.location.line}`, `col=${bounded.location.column}`);
  }
  return `::${level} ${properties.join(",")}::${commandData(`${bounded.message}: ${displayEvidence(bounded)}`)}
`;
}
function annotationCommands(findings) {
  const used = { error: 0, warning: 0, notice: 0 };
  const omitted = { error: 0, warning: 0, notice: 0 };
  const selected = [];
  for (const finding of findings) {
    const level = annotationLevel(finding);
    if (used[level] < MAX_ANNOTATIONS_PER_LEVEL) {
      used[level] += 1;
      selected.push({ finding, level });
    } else {
      omitted[level] += 1;
    }
  }
  let omittedTotal = omitted.error + omitted.warning + omitted.notice;
  if (omittedTotal > 0 && used.notice === MAX_ANNOTATIONS_PER_LEVEL) {
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (selected[index]?.level !== "notice") continue;
      selected.splice(index, 1);
      used.notice -= 1;
      omitted.notice += 1;
      omittedTotal += 1;
      break;
    }
  }
  const commands = selected.map((item) => annotationCommand(item.finding));
  if (omittedTotal > 0) {
    const message = `SurfaceGuard omitted ${omittedTotal} finding annotation(s) to bound log output (errors: ${omitted.error}, warnings: ${omitted.warning}, notices: ${omitted.notice}). See the job summary or SARIF for retained details.`;
    commands.push(
      `::notice title=${commandProperty("SurfaceGuard annotation limit")}::${commandData(message)}
`
    );
  }
  return commands;
}

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
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new SurfaceGuardError("SG_ABORTED", "Artifact scan was aborted");
  }
}
function rethrowOperationalError(error) {
  if (error instanceof SurfaceGuardError) throw error;
}

// src/policy.ts
var import_promises = require("fs/promises");
var import_node_path = require("path");

// src/constants.ts
var VERSION = "0.5.1";
var DEFAULT_LIMITS = Object.freeze({
  maxEntries: 1e5,
  maxDirectories: 1e4,
  maxDepth: 64,
  maxFiles: 5e4,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRoutes: 5e4,
  maxManifestEntries: 1e5,
  maxSitemapEntries: 5e4,
  maxRobotsRules: 5e4,
  maxRobotsComparisons: 1e6,
  maxRobotsWork: 64 * 1024 * 1024,
  maxFindings: 1e3,
  maxDecodePasses: 3,
  maxPatternLength: 1024
});

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

// src/decode.ts
var IDENTITY_SPAN_VARIANTS = /* @__PURE__ */ new WeakSet();
function identitySpans(text) {
  return Array.from({ length: text.length }, (_, index) => ({
    start: index,
    end: index + 1
  }));
}
function sourceSpanAt(input2, index) {
  return IDENTITY_SPAN_VARIANTS.has(input2) ? { start: index, end: index + 1 } : input2.spans[index];
}
function originalSourceLength(input2) {
  return input2.sourceLength ?? input2.spans.at(-1)?.end ?? input2.text.length;
}
function decodeHexEscapes(input2) {
  if (!/\\(?:x[0-9a-f]{2}|u[0-9a-f]{4}|u\{[0-9a-f]{1,6}\})/iu.test(input2.text))
    return void 0;
  let output = "";
  const spans = [];
  let changed = false;
  for (let index = 0; index < input2.text.length; index += 1) {
    const escaped = input2.text[index] === "\\";
    const short = escaped ? /^\\x([0-9a-f]{2})/iu.exec(input2.text.slice(index)) : null;
    const long = escaped ? /^\\u([0-9a-f]{4})/iu.exec(input2.text.slice(index)) : null;
    const braced = escaped ? /^\\u\{([0-9a-f]{1,6})\}/iu.exec(input2.text.slice(index)) : null;
    const bracedCodePoint = braced?.[1] ? Number.parseInt(braced[1], 16) : void 0;
    const match = bracedCodePoint !== void 0 && bracedCodePoint <= 1114111 ? braced : long ?? short;
    if (match?.[1]) {
      const width = match[0].length;
      const decoded = String.fromCodePoint(Number.parseInt(match[1], 16));
      output += decoded;
      const first = sourceSpanAt(input2, index);
      const last = sourceSpanAt(input2, index + width - 1);
      if (first && last) {
        const span2 = { start: first.start, end: last.end };
        spans.push(span2);
        if (decoded.length === 2) spans.push(span2);
      }
      index += width - 1;
      changed = true;
      continue;
    }
    output += input2.text[index] ?? "";
    const span = sourceSpanAt(input2, index);
    if (span) spans.push(span);
  }
  return changed ? {
    text: output,
    spans,
    sourceLength: originalSourceLength(input2),
    transform: `${input2.transform}+js-hex`
  } : void 0;
}
function hexNibble(code) {
  if (code >= 48 && code <= 57) return code - 48;
  const folded = code | 32;
  return folded >= 97 && folded <= 102 ? folded - 87 : -1;
}
function isContinuation(byte) {
  return byte >= 128 && byte <= 191;
}
function isValidUtf8Scalar(bytes, start, end) {
  const length = end - start;
  const lead = bytes[start] ?? 0;
  if (length === 2) {
    return lead >= 194 && lead <= 223 && isContinuation(bytes[start + 1] ?? 0);
  }
  if (length === 3 && isContinuation(bytes[start + 2] ?? 0)) {
    const second = bytes[start + 1] ?? 0;
    return lead === 224 && second >= 160 && second <= 191 || lead >= 225 && lead <= 236 && isContinuation(second) || lead === 237 && second >= 128 && second <= 159 || lead >= 238 && lead <= 239 && isContinuation(second);
  }
  if (length === 4 && isContinuation(bytes[start + 2] ?? 0) && isContinuation(bytes[start + 3] ?? 0)) {
    const second = bytes[start + 1] ?? 0;
    return lead === 240 && second >= 144 && second <= 191 || lead >= 241 && lead <= 243 && isContinuation(second) || lead === 244 && second >= 128 && second <= 143;
  }
  return false;
}
function utf8ScalarWidth(bytes, start) {
  const lead = bytes[start] ?? 0;
  if (lead <= 127) return 1;
  for (const width of [2, 3, 4]) {
    if (start + width <= bytes.length && isValidUtf8Scalar(bytes, start, start + width)) {
      return width;
    }
  }
  return 0;
}
function utf8CodePoint(bytes, start, width) {
  const first = bytes[start] ?? 0;
  if (width === 1) return first;
  if (width === 2) return (first & 31) << 6 | (bytes[start + 1] ?? 0) & 63;
  if (width === 3) {
    return (first & 15) << 12 | ((bytes[start + 1] ?? 0) & 63) << 6 | (bytes[start + 2] ?? 0) & 63;
  }
  return (first & 7) << 18 | ((bytes[start + 1] ?? 0) & 63) << 12 | ((bytes[start + 2] ?? 0) & 63) << 6 | (bytes[start + 3] ?? 0) & 63;
}
function decodePercent(input2) {
  if (!/%[0-9a-f]{2}/iu.test(input2.text)) return void 0;
  const output = [];
  const spans = [];
  let changed = false;
  for (let index = 0; index < input2.text.length; ) {
    const first = hexNibble(input2.text.charCodeAt(index + 1));
    const second = hexNibble(input2.text.charCodeAt(index + 2));
    if (input2.text[index] !== "%" || first < 0 || second < 0) {
      output.push(input2.text[index] ?? "");
      const span = sourceSpanAt(input2, index);
      if (span) spans.push(span);
      index += 1;
      continue;
    }
    const runStart = index;
    while (input2.text[index] === "%" && hexNibble(input2.text.charCodeAt(index + 1)) >= 0 && hexNibble(input2.text.charCodeAt(index + 2)) >= 0) {
      index += 3;
    }
    const runEnd = index;
    const bytes = new Uint8Array((runEnd - runStart) / 3);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      const raw = runStart + offset * 3;
      bytes[offset] = hexNibble(input2.text.charCodeAt(raw + 1)) << 4 | hexNibble(input2.text.charCodeAt(raw + 2));
    }
    for (let byteIndex = 0; byteIndex < bytes.length; ) {
      const firstWidth = utf8ScalarWidth(bytes, byteIndex);
      if (firstWidth === 0) {
        const rawStart = runStart + byteIndex * 3;
        for (let raw = rawStart; raw < rawStart + 3; raw += 1) {
          output.push(input2.text[raw] ?? "");
          const span = sourceSpanAt(input2, raw);
          if (span) spans.push(span);
        }
        byteIndex += 1;
        continue;
      }
      const segmentStart = byteIndex;
      byteIndex += firstWidth;
      while (byteIndex < bytes.length) {
        const width = utf8ScalarWidth(bytes, byteIndex);
        if (width === 0) break;
        byteIndex += width;
      }
      const segmentEnd = byteIndex;
      let scalar = segmentStart;
      let firstScalar = true;
      while (scalar < segmentEnd) {
        const scalarStart = scalar;
        const width = utf8ScalarWidth(bytes, scalar);
        const codePoint = utf8CodePoint(bytes, scalar, width);
        scalar += width;
        if (firstScalar && codePoint === 65279) {
          firstScalar = false;
          continue;
        }
        firstScalar = false;
        const rawStart = runStart + scalarStart * 3;
        const rawEnd = runStart + scalar * 3;
        const decodedFirst = sourceSpanAt(input2, rawStart);
        const decodedLast = sourceSpanAt(input2, rawEnd - 1);
        if (!decodedFirst || !decodedLast) continue;
        const decodedSpan = { start: decodedFirst.start, end: decodedLast.end };
        const decoded = String.fromCodePoint(codePoint);
        output.push(decoded);
        spans.push(decodedSpan);
        if (decoded.length === 2) {
          spans.push(decodedSpan);
        }
      }
      changed = true;
    }
  }
  return changed ? {
    text: output.join(""),
    spans,
    sourceLength: originalSourceLength(input2),
    transform: `${input2.transform}+percent`
  } : void 0;
}
function variantsForText(text, maxPasses, materializeIdentitySpans) {
  const original = {
    text,
    spans: materializeIdentitySpans ? identitySpans(text) : [],
    sourceLength: text.length,
    transform: "raw"
  };
  if (!materializeIdentitySpans) IDENTITY_SPAN_VARIANTS.add(original);
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
function decodeTextVariantsForMatching(text, maxPasses) {
  return variantsForText(text, maxPasses, false);
}
function rawSpanForMatch(variant, start, length) {
  if (length === 0) {
    if (IDENTITY_SPAN_VARIANTS.has(variant)) return { start, end: start };
    if (start === 0 && variant.text.length === 0) {
      const boundary2 = originalSourceLength(variant);
      return { start: boundary2, end: boundary2 };
    }
    const boundary = start < variant.text.length ? sourceSpanAt(variant, start)?.start : sourceSpanAt(variant, start - 1)?.end;
    return boundary === void 0 ? void 0 : { start: boundary, end: boundary };
  }
  const first = sourceSpanAt(variant, start);
  const last = sourceSpanAt(variant, Math.max(start, start + length - 1));
  return first && last ? { start: first.start, end: last.end } : void 0;
}
function decodePercentText(text) {
  if (!/%[0-9a-f]{2}/iu.test(text)) return void 0;
  const output = [];
  let changed = false;
  for (let index = 0; index < text.length; ) {
    if (text[index] !== "%" || hexNibble(text.charCodeAt(index + 1)) < 0 || hexNibble(text.charCodeAt(index + 2)) < 0) {
      output.push(text[index] ?? "");
      index += 1;
      continue;
    }
    const runStart = index;
    while (text[index] === "%" && hexNibble(text.charCodeAt(index + 1)) >= 0 && hexNibble(text.charCodeAt(index + 2)) >= 0) {
      index += 3;
    }
    const bytes = new Uint8Array((index - runStart) / 3);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      const raw = runStart + offset * 3;
      bytes[offset] = hexNibble(text.charCodeAt(raw + 1)) << 4 | hexNibble(text.charCodeAt(raw + 2));
    }
    for (let byteIndex = 0; byteIndex < bytes.length; ) {
      const firstWidth = utf8ScalarWidth(bytes, byteIndex);
      if (firstWidth === 0) {
        const raw = runStart + byteIndex * 3;
        output.push(text.slice(raw, raw + 3));
        byteIndex += 1;
        continue;
      }
      let firstScalar = true;
      while (byteIndex < bytes.length) {
        const width = utf8ScalarWidth(bytes, byteIndex);
        if (width === 0) break;
        const codePoint = utf8CodePoint(bytes, byteIndex, width);
        byteIndex += width;
        if (firstScalar && codePoint === 65279) {
          firstScalar = false;
          continue;
        }
        firstScalar = false;
        output.push(String.fromCodePoint(codePoint));
      }
      changed = true;
    }
  }
  return changed ? output.join("") : void 0;
}
function repeatedlyDecodeUrl(value, maxPasses = 3) {
  let current = value;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const decoded = decodePercentText(current);
    if (!decoded || decoded === current) break;
    current = decoded;
  }
  return current;
}
var ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:/iu;
function independentlyParseAbsoluteUrl(value, maxPasses) {
  let current = value;
  for (let pass = 0; pass <= maxPasses; pass += 1) {
    if (ABSOLUTE_URL.test(current)) {
      try {
        return { url: new URL(current), passes: pass };
      } catch {
      }
    }
    if (pass === maxPasses) break;
    const decoded = decodePercentText(current);
    if (!decoded || decoded === current) return void 0;
    current = decoded;
  }
  return void 0;
}
function canonicalizeUrl(value, maxPasses = 3) {
  const input2 = value.trim().replaceAll("\\", "/");
  const absolute = independentlyParseAbsoluteUrl(input2, maxPasses);
  const remainingPasses = maxPasses - (absolute?.passes ?? 0);
  const relative2 = input2.replace(/^\/{2,}/u, "/");
  const url = absolute?.url ?? new URL(relative2, "https://surfaceguard.invalid");
  url.pathname = repeatedlyDecodeUrl(url.pathname, remainingPasses).replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.protocol === "https:" && url.port === "443" || url.protocol === "http:" && url.port === "80") {
    url.port = "";
  }
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}

// src/matcher.ts
function locationAt(text, offset, cursor) {
  if (offset < cursor.offset) {
    cursor.offset = 0;
    cursor.line = 1;
    cursor.lineStart = 0;
  }
  while (cursor.offset < offset) {
    const code = text.charCodeAt(cursor.offset);
    if (code === 13) {
      if (text.charCodeAt(cursor.offset + 1) === 10 && cursor.offset + 1 < offset) {
        cursor.offset += 1;
      }
      cursor.line += 1;
      cursor.lineStart = cursor.offset + 1;
    } else if (code === 10) {
      cursor.line += 1;
      cursor.lineStart = cursor.offset + 1;
    }
    cursor.offset += 1;
  }
  return { line: cursor.line, column: offset - cursor.lineStart + 1, offset };
}
function compilePatternRule(rule, limits, path) {
  if (rule.pattern.length > limits.maxPatternLength) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `Pattern ${rule.id} exceeds maxPatternLength`,
      {
        ruleId: rule.id,
        ...path ? { path } : {},
        limit: limits.maxPatternLength
      }
    );
  }
  if (rule.match !== "regex") return void 0;
  if (/\([^)]*[+*][^)]*\)[+*{]/u.test(rule.pattern)) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `Pattern ${rule.id} contains a nested quantifier`,
      {
        ruleId: rule.id,
        ...path ? { path } : {}
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
        ...path ? { path } : {},
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
}
function* literalMatches(text, pattern, caseSensitive) {
  if (!caseSensitive) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    yield* regexMatches(text, new RegExp(escaped, "giu"));
    return;
  }
  let offset = 0;
  while (pattern.length > 0) {
    const index = text.indexOf(pattern, offset);
    if (index < 0) break;
    yield [index, pattern.length];
    offset = index + Math.max(1, pattern.length);
  }
}
function codePointWidthAt(text, index) {
  const codePoint = text.codePointAt(index);
  return codePoint !== void 0 && codePoint > 65535 ? 2 : 1;
}
function* regexMatches(text, regex) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    yield [match.index, match[0].length];
    if (match[0].length === 0) {
      regex.lastIndex += codePointWidthAt(text, regex.lastIndex);
    }
  }
}
function matchPatternRule(raw, file, rule, category, limits) {
  if (rule.scopes && !rule.scopes.includes("all") && !rule.scopes.includes(file.kind))
    return [];
  const regex = compilePatternRule(rule, limits);
  const variants = decodeTextVariantsForMatching(raw, limits.maxDecodePasses);
  const findings = [];
  const seen = /* @__PURE__ */ new Set();
  for (const variant of variants) {
    const locationCursor = { offset: 0, line: 1, lineStart: 0 };
    const matches = regex ? regexMatches(variant.text, regex) : literalMatches(variant.text, rule.pattern, rule.caseSensitive !== false);
    for (const [start, length] of matches) {
      const span = rawSpanForMatch(variant, start, length);
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
        location: locationAt(raw, span.start, locationCursor),
        transform: variant.transform,
        help: `Remove the matched material from the produced ${file.kind} artifact or narrow the policy deliberately.`
      });
      if (findings.length >= limits.maxFindings) return findings;
    }
  }
  return findings;
}

// src/policy.ts
var SEVERITIES = /* @__PURE__ */ new Set(["error", "warning", "note"]);
var ADAPTERS = /* @__PURE__ */ new Set(["auto", "astro", "generic", "nextjs", "vite"]);
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
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path} must be an array of non-empty strings`,
      {
        path
      }
    );
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.length === 0) {
      throw new SurfaceGuardError(
        "SG_CONFIG_INVALID",
        `${path}[${index}] must be a non-empty string`,
        { path: `${path}[${index}]` }
      );
    }
    result.push(item);
  }
  const firstIndexes = /* @__PURE__ */ new Map();
  for (const [index, item] of result.entries()) {
    const firstIndex = firstIndexes.get(item);
    if (firstIndex !== void 0) {
      throw new SurfaceGuardError(
        "SG_CONFIG_INVALID",
        `${path}[${index}] duplicates ${path}[${firstIndex}]`,
        {
          path: `${path}[${index}]`,
          duplicateOf: `${path}[${firstIndex}]`
        }
      );
    }
    firstIndexes.set(item, index);
  }
  return result;
}
function validateGlob(glob, path, limits) {
  if (glob.length > limits.maxPatternLength) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path} exceeds maxPatternLength`, {
      path,
      limit: limits.maxPatternLength
    });
  }
  try {
    globToRegExp(glob);
  } catch (error) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path} is not a valid glob`, {
      path,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
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
  if (Buffer.byteLength(item.id, "utf8") > MAX_RETAINED_RULE_ID_BYTES) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.id exceeds the output-safe identifier limit`,
      { path: `${path}.id`, limit: MAX_RETAINED_RULE_ID_BYTES }
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
  if (typeof item.message === "string" && Buffer.byteLength(item.message, "utf8") > MAX_RETAINED_MESSAGE_BYTES) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.message exceeds the output-safe message limit`,
      { path: `${path}.message`, limit: MAX_RETAINED_MESSAGE_BYTES }
    );
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
  if (Buffer.byteLength(item.id, "utf8") > MAX_RETAINED_RULE_ID_BYTES) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.id exceeds the output-safe identifier limit`,
      { path: `${path}.id`, limit: MAX_RETAINED_RULE_ID_BYTES }
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
  if (item.message !== void 0 && typeof item.message !== "string") {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path}.message must be a string`, {
      path
    });
  }
  if (typeof item.message === "string" && Buffer.byteLength(item.message, "utf8") > MAX_RETAINED_MESSAGE_BYTES) {
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `${path}.message exceeds the output-safe message limit`,
      { path: `${path}.message`, limit: MAX_RETAINED_MESSAGE_BYTES }
    );
  }
  return item;
}
function validatePatternRules(value, path) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path} must be an array`, { path });
  }
  return Array.from(value, (item, index) => validatePatternRule(item, `${path}[${index}]`));
}
function validateFileRules(value, path) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) {
    throw new SurfaceGuardError("SG_CONFIG_INVALID", `${path} must be an array`, { path });
  }
  return Array.from(value, (item, index) => validateFileRule(item, `${path}[${index}]`));
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
      "adapter must be auto, astro, generic, nextjs, or vite",
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
  const globs = [];
  const patternRules = [];
  const exclude = strings(root.exclude, "$.exclude");
  exclude?.forEach((glob, index) => globs.push({ glob, path: `$.exclude[${index}]` }));
  if (root.routes !== void 0) {
    const routes = record(root.routes, "$.routes");
    assertKnownKeys(routes, ["allow", "deny", "require"], "$.routes");
    for (const key of ["allow", "deny", "require"]) {
      const routeGlobs = strings(routes[key], `$.routes.${key}`);
      routeGlobs?.forEach(
        (glob, index) => globs.push({ glob, path: `$.routes.${key}[${index}]` })
      );
    }
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
    for (const key of ["text", "endpoints", "metadata"]) {
      const path = `$.forbidden.${key}`;
      const rules = validatePatternRules(forbidden[key], path);
      if (rules) patternRules.push({ rules, path });
    }
    const fileRules = validateFileRules(forbidden.files, "$.forbidden.files");
    fileRules?.forEach(
      (rule, index) => globs.push({ glob: rule.glob, path: `$.forbidden.files[${index}].glob` })
    );
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
    const limits2 = record(root.limits, "$.limits");
    assertKnownKeys(limits2, Object.keys(DEFAULT_LIMITS), "$.limits");
    for (const [key, value2] of Object.entries(limits2)) {
      if (!Number.isSafeInteger(value2) || value2 <= 0) {
        const path = `$.limits.${key}`;
        throw new SurfaceGuardError(
          "SG_CONFIG_INVALID",
          `${path} must be a positive integer`,
          { path }
        );
      }
    }
  }
  const limits = {
    ...DEFAULT_LIMITS,
    ...root.limits
  };
  for (const { glob, path } of globs) validateGlob(glob, path, limits);
  for (const { rules, path } of patternRules) {
    rules.forEach(
      (rule, index) => compilePatternRule(rule, limits, `${path}[${index}].pattern`)
    );
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
var SEVERITY_RANK = {
  error: 2,
  warning: 1,
  note: 0
};
function location(finding) {
  if (!finding.location) return finding.artifactPath;
  return `${finding.artifactPath}:${finding.location.line}:${finding.location.column}`;
}
function row(finding) {
  return `| ${finding.severity} | ${markdownCell(finding.ruleId)} | ${markdownCell(location(finding))} | ${markdownCell(displayEvidence(finding))} |`;
}
function omittedRowsNotice(count) {
  return `Markdown output omitted ${count} retained finding row(s) to keep this report within ${MAX_MARKDOWN_REPORT_BYTES} UTF-8 bytes.`;
}
function renderMarkdown(result) {
  const status = result.failed ? "failed" : "passed";
  const adapter = markdownCell(boundOutputText(result.adapter, MAX_RETAINED_MESSAGE_BYTES));
  const findings = result.findings.map(boundFindingEvidence);
  const truncatedEvidence = Math.max(
    result.completeness.truncatedEvidence ?? 0,
    findings.filter((finding) => finding.evidenceTruncated).length
  );
  const lines = [
    "# SurfaceGuard report",
    "",
    `Status: **${status}**`,
    "",
    `Adapter: ${adapter}`,
    "",
    `Scanned ${result.statistics.filesScanned} text artifacts (${result.statistics.bytesVisited} bytes) and discovered ${result.statistics.routesFound} routes.`,
    ""
  ];
  if (result.completeness.textInspection === "incomplete") {
    lines.push(
      `${result.completeness.unsupportedTextArtifacts} text artifact(s) used an unsupported or ambiguous encoding. Best-effort matching continued, but text inspection is incomplete.`,
      ""
    );
  }
  if (result.completeness.findingDetails === "truncated") {
    lines.push(
      `Finding rows were truncated at ${result.completeness.findingLimit} retained item(s); at least ${result.completeness.observedFindingsAtLeast} finding(s) were observed.`,
      ""
    );
  }
  if (truncatedEvidence > 0) {
    lines.push(
      `${truncatedEvidence} retained finding evidence value(s) exceeded ${result.completeness.evidenceLimit ?? MAX_RETAINED_EVIDENCE_BYTES} UTF-8 bytes and are shown as bounded prefixes.`,
      ""
    );
  }
  if (findings.length === 0) {
    lines.push("No findings.", "");
    return `${lines.join("\n")}
`;
  }
  const tableHeader = [
    "| Severity | Rule | Artifact | Evidence |",
    "| --- | --- | --- | --- |"
  ];
  const rows = findings.map((finding, index) => ({
    finding,
    index,
    text: row(finding)
  }));
  const complete = [...lines, ...tableHeader, ...rows.map((item) => item.text), ""];
  const completeReport = `${complete.join("\n")}
`;
  if (Buffer.byteLength(completeReport, "utf8") <= MAX_MARKDOWN_REPORT_BYTES) {
    return completeReport;
  }
  const prefix = `${[...lines, ...tableHeader].join("\n")}
`;
  const maximumNotice = `${omittedRowsNotice(rows.length)}
`;
  let available = MAX_MARKDOWN_REPORT_BYTES - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(maximumNotice, "utf8") - 2;
  const selected = /* @__PURE__ */ new Set();
  const prioritized = [...rows].sort(
    (left, right) => SEVERITY_RANK[right.finding.severity] - SEVERITY_RANK[left.finding.severity] || left.index - right.index
  );
  for (const item of prioritized) {
    const bytes = Buffer.byteLength(`${item.text}
`, "utf8");
    if (bytes > available) continue;
    selected.add(item.index);
    available -= bytes;
  }
  const retainedRows = rows.filter((item) => selected.has(item.index)).map((item) => item.text);
  const omitted = rows.length - retainedRows.length;
  return `${[
    ...lines,
    ...tableHeader,
    ...retainedRows,
    "",
    omittedRowsNotice(omitted),
    ""
  ].join("\n")}
`;
}

// src/reporters/sarif.ts
var import_node_crypto2 = require("crypto");
function fingerprint(finding) {
  return (0, import_node_crypto2.createHash)("sha256").update(
    [
      finding.ruleId,
      finding.artifactPath,
      finding.location?.offset ?? "",
      finding.evidenceSha256 ? `sha256:${finding.evidenceSha256}` : finding.evidence ?? ""
    ].join("\0")
  ).digest("hex");
}
function toSarif(result) {
  const findings = result.findings.map(boundFindingEvidence);
  const truncatedEvidence = Math.max(
    result.completeness.truncatedEvidence ?? 0,
    findings.filter((finding) => finding.evidenceTruncated).length
  );
  const ruleIds = [...new Set(findings.map((finding) => finding.ruleId))].sort();
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        properties: {
          textInspection: result.completeness.textInspection,
          findingDetails: result.completeness.findingDetails,
          findingLimit: result.completeness.findingLimit,
          retainedFindings: result.completeness.retainedFindings,
          observedFindingsAtLeast: result.completeness.observedFindingsAtLeast,
          evidenceDetails: truncatedEvidence === 0 ? "complete" : "truncated",
          evidenceLimit: result.completeness.evidenceLimit ?? MAX_RETAINED_EVIDENCE_BYTES,
          truncatedEvidence,
          unsupportedTextArtifacts: result.completeness.unsupportedTextArtifacts
        },
        tool: {
          driver: {
            name: "SurfaceGuard",
            semanticVersion: result.tool.version,
            informationUri: "https://github.com/tovellan/surfaceguard",
            rules: ruleIds.map((ruleId) => ({ id: ruleId, name: ruleId }))
          }
        },
        results: findings.map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.severity === "error" ? "error" : finding.severity === "warning" ? "warning" : "note",
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: relativeSarifUri(finding.artifactPath) },
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
            evidenceTruncated: finding.evidenceTruncated,
            evidenceBytes: finding.evidenceBytes,
            evidenceSha256: finding.evidenceSha256,
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
var import_node_path8 = require("path");

// src/adapters/index.ts
var import_node_path6 = require("path");

// src/adapters/astro.ts
var import_node_path3 = require("path");

// src/adapters/generic.ts
var import_node_path2 = require("path");

// src/adapters/limits.ts
var AdapterBudget = class {
  constructor(context) {
    this.context = context;
  }
  context;
  manifestEntries = 0;
  checkSignal() {
    throwIfAborted(this.context.signal);
  }
  inspectManifest(value, artifactPath) {
    const pending = [{ value, depth: 0 }];
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
      } else if (current.value && typeof current.value === "object") {
        const record2 = current.value;
        for (const key in record2) {
          if (!Object.hasOwn(record2, key)) continue;
          this.visitManifestEntry(artifactPath);
          this.checkManifestDepth(current.depth + 1, artifactPath);
          pending.push({ value: record2[key], depth: current.depth + 1 });
        }
      }
    }
  }
  addRoute(routes, evidence) {
    this.checkSignal();
    if (routes.length + 1 > this.context.limits.maxRoutes) {
      throw new SurfaceGuardError(
        "SG_RESOURCE_LIMIT",
        "Route evidence count exceeds maxRoutes",
        {
          artifactPath: evidence.artifactPath,
          limit: this.context.limits.maxRoutes,
          observed: routes.length + 1
        }
      );
    }
    routes.push(evidence);
  }
  visitManifestEntry(artifactPath) {
    this.checkSignal();
    this.manifestEntries += 1;
    if (this.manifestEntries > this.context.limits.maxManifestEntries) {
      throw new SurfaceGuardError(
        "SG_RESOURCE_LIMIT",
        "Manifest entry count exceeds maxManifestEntries",
        {
          artifactPath,
          limit: this.context.limits.maxManifestEntries,
          observed: this.manifestEntries
        }
      );
    }
  }
  checkManifestDepth(depth, artifactPath) {
    if (depth > this.context.limits.maxDepth) {
      throw new SurfaceGuardError("SG_RESOURCE_LIMIT", "Manifest depth exceeds maxDepth", {
        artifactPath,
        limit: this.context.limits.maxDepth,
        observed: depth
      });
    }
  }
};

// src/adapters/generic.ts
var ROUTE_KEYS = /* @__PURE__ */ new Set(["page", "path", "pathname", "route"]);
var SITEMAP_FILENAME = /^sitemap(?:(?:[_-]?index)|(?:[_-]?\d+)|(?:-[^/]*))?\.xml(?:\.gz)?$/u;
function classifyGeneric(relativePath) {
  const lower = relativePath.toLowerCase();
  const name = (0, import_node_path2.basename)(lower);
  const extension = (0, import_node_path2.extname)(lower);
  if (name === "robots.txt") return "robots";
  if (SITEMAP_FILENAME.test(name)) return "sitemap";
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
function walkRoutes(value, artifactPath, routes, budget) {
  const pending = [
    { value, pointer: "" }
  ];
  while (pending.length > 0) {
    budget.checkSignal();
    const current = pending.pop();
    if (!current) continue;
    if (typeof current.value === "string") {
      if (current.value.startsWith("/") && (current.key === void 0 || ROUTE_KEYS.has(current.key))) {
        budget.addRoute(routes, {
          route: current.value,
          artifactPath,
          pointer: current.pointer
        });
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          pointer: `${current.pointer}/${index}`,
          ...current.key === void 0 ? {} : { key: current.key }
        });
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const record2 = current.value;
    const keys = Object.keys(record2);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const childKey = keys[index];
      if (childKey === void 0) continue;
      pending.push({
        value: record2[childKey],
        pointer: `${current.pointer}/${childKey}`,
        key: childKey
      });
    }
  }
}
var genericAdapter = {
  name: "generic",
  detect: () => 1,
  classify: classifyGeneric,
  async collectRoutes(context) {
    const routes = [];
    const findings = [];
    const budget = new AdapterBudget(context);
    for (const file of context.files.filter(
      (candidate) => candidate.kind === "route-manifest"
    )) {
      try {
        const value = JSON.parse(await context.readText(file));
        budget.inspectManifest(value, file.relativePath);
        walkRoutes(value, file.relativePath, routes, budget);
      } catch (error) {
        rethrowOperationalError(error);
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

// src/adapters/artifact-path.ts
function encodeArtifactPath(relativePath) {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

// src/adapters/astro.ts
var ASTRO_ASSET_DIRECTORY = "_astro/";
function isHtml(relativePath) {
  return (0, import_node_path3.extname)(relativePath.toLowerCase()) === ".html";
}
function routeForHtml(relativePath) {
  if (relativePath === "index.html") return "/";
  if (relativePath.endsWith("/index.html")) {
    return `/${encodeArtifactPath(relativePath.slice(0, -"index.html".length))}`;
  }
  return `/${encodeArtifactPath(relativePath)}`;
}
var astroAdapter = {
  name: "astro",
  detect(files) {
    const hasDefaultAssets = files.some(
      (file) => file.relativePath.startsWith(ASTRO_ASSET_DIRECTORY)
    );
    const hasHtml = files.some((file) => isHtml(file.relativePath));
    return hasDefaultAssets && hasHtml ? files.length * 16 + 1 : 0;
  },
  classify(relativePath) {
    const generic = classifyGeneric(relativePath);
    if (generic === "source-map" || generic === "server-bundle") return generic;
    if ([".js", ".cjs", ".mjs"].includes((0, import_node_path3.extname)(relativePath.toLowerCase()))) {
      return "client-chunk";
    }
    return generic;
  },
  collectRoutes(context) {
    return Promise.resolve().then(() => {
      const routes = [];
      const budget = new AdapterBudget(context);
      for (const file of context.files.filter(
        (candidate) => isHtml(candidate.relativePath)
      )) {
        budget.addRoute(routes, {
          route: routeForHtml(file.relativePath),
          artifactPath: file.relativePath,
          pointer: "/",
          routeKind: "artifact-path"
        });
      }
      return { routes, findings: [] };
    });
  }
};

// src/adapters/nextjs.ts
var import_node_path4 = require("path");
var NEXT_MANIFESTS = /* @__PURE__ */ new Set([
  "app-path-routes-manifest.json",
  "app-paths-manifest.json",
  "build-manifest.json",
  "pages-manifest.json",
  "prerender-manifest.json",
  "routes-manifest.json"
]);
var NEXT_INTERNAL_APP_ROUTES = /* @__PURE__ */ new Set(["/_global-error", "/_not-found"]);
function isNextManifest(relativePath) {
  return NEXT_MANIFESTS.has((0, import_node_path4.basename)(relativePath));
}
function addRoute(routes, seen, route, file, pointer, budget, normalize = (value) => value) {
  if (typeof route !== "string" || !route.startsWith("/")) return;
  const normalized = normalize(route);
  if (!normalized) return;
  const key = `${normalized}\0${file.relativePath}\0${pointer}`;
  if (seen.has(key)) return;
  seen.add(key);
  budget.addRoute(routes, {
    route: normalized,
    artifactPath: file.relativePath,
    pointer
  });
}
function normalizeAppPath(route) {
  const segments = route.split("/").filter(Boolean);
  if (segments.at(-1) === "page" || segments.at(-1) === "route") segments.pop();
  const publicSegments = [];
  for (let segment of segments) {
    if (segment.startsWith("@") || /^\([^/]+\)$/u.test(segment)) continue;
    if (segment.startsWith("(...)")) {
      publicSegments.length = 0;
      segment = segment.slice(5);
    } else {
      while (segment.startsWith("(..)")) {
        publicSegments.pop();
        segment = segment.slice(4);
      }
      if (segment.startsWith("(.)")) segment = segment.slice(3);
    }
    if (segment) publicSegments.push(segment);
  }
  const normalized = publicSegments.length > 0 ? `/${publicSegments.join("/")}` : "/";
  return NEXT_INTERNAL_APP_ROUTES.has(normalized) ? void 0 : normalized;
}
function normalizeAppRoute(route) {
  return NEXT_INTERNAL_APP_ROUTES.has(route) ? void 0 : route;
}
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function objectSection(root, section, manifest) {
  const value = root[section];
  if (value === void 0) return void 0;
  const object = objectValue(value);
  if (!object) throw new TypeError(`${manifest} ${section} must be an object`);
  return object;
}
function objectArraySection(root, section, manifest) {
  const value = root[section];
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.some((entry) => objectValue(entry) === void 0)) {
    throw new TypeError(`${manifest} ${section} must be an array of objects`);
  }
  return value;
}
function requiredRoute(value, location2) {
  if (typeof value !== "string" || value.length === 0 || !value.startsWith("/")) {
    throw new TypeError(`${location2} must name a non-empty absolute route string`);
  }
  return value;
}
function rewriteSections(root, manifest) {
  const value = root.rewrites;
  if (value === void 0) return [];
  if (Array.isArray(value)) {
    if (value.some((entry) => objectValue(entry) === void 0)) {
      throw new TypeError(`${manifest} rewrites must be an array of objects`);
    }
    return [{ entries: value }];
  }
  const groups = objectValue(value);
  if (!groups) {
    throw new TypeError(`${manifest} rewrites must be an array or grouped object`);
  }
  const sections = [];
  for (const group of ["beforeFiles", "afterFiles", "fallback"]) {
    const entries = groups[group];
    if (entries === void 0) continue;
    if (!Array.isArray(entries) || entries.some((entry) => objectValue(entry) === void 0)) {
      throw new TypeError(`${manifest} rewrites.${group} must be an array of objects`);
    }
    sections.push({ group, entries });
  }
  return sections;
}
function collectNextRoutes(value, file, routes, budget) {
  const root = objectValue(value);
  if (!root) throw new TypeError("Manifest root must be an object");
  const seen = /* @__PURE__ */ new Set();
  const name = (0, import_node_path4.basename)(file.relativePath);
  if (name === "pages-manifest.json") {
    Object.keys(root).forEach(
      (route) => addRoute(routes, seen, route, file, `/${route}`, budget)
    );
    return;
  }
  if (name === "app-paths-manifest.json") {
    Object.keys(root).forEach(
      (route) => addRoute(routes, seen, route, file, `/${route}`, budget, normalizeAppPath)
    );
    return;
  }
  if (name === "app-path-routes-manifest.json") {
    Object.entries(root).forEach(
      ([appPath, route]) => addRoute(
        routes,
        seen,
        requiredRoute(route, `${name} ${appPath}`),
        file,
        `/${appPath}`,
        budget,
        normalizeAppRoute
      )
    );
    return;
  }
  if (name === "build-manifest.json") {
    const pages = objectSection(root, "pages", name);
    Object.keys(pages ?? {}).forEach(
      (route) => addRoute(routes, seen, route, file, `/pages/${route}`, budget)
    );
    return;
  }
  if (name === "prerender-manifest.json") {
    for (const section of ["routes", "dynamicRoutes"]) {
      const entries = objectSection(root, section, name);
      Object.keys(entries ?? {}).forEach(
        (route) => addRoute(routes, seen, route, file, `/${section}/${route}`, budget)
      );
    }
    return;
  }
  if (name === "routes-manifest.json") {
    for (const section of [
      "staticRoutes",
      "dynamicRoutes",
      "dataRoutes",
      "redirects"
    ]) {
      const entries = objectArraySection(root, section, name) ?? [];
      entries.forEach((candidate, index) => {
        const location2 = `${name} ${section}[${index}]`;
        addRoute(
          routes,
          seen,
          requiredRoute(
            section === "redirects" ? candidate.source : candidate.page ?? candidate.source ?? candidate.pathname,
            location2
          ),
          file,
          `/${section}/${index}`,
          budget
        );
      });
    }
    for (const rewrite of rewriteSections(root, name)) {
      rewrite.entries.forEach((candidate, index) => {
        const location2 = rewrite.group ? `${name} rewrites.${rewrite.group}[${index}]` : `${name} rewrites[${index}]`;
        addRoute(
          routes,
          seen,
          requiredRoute(candidate.source, location2),
          file,
          rewrite.group ? `/rewrites/${rewrite.group}/${index}` : `/rewrites/${index}`,
          budget
        );
      });
    }
  }
}
var nextjsAdapter = {
  name: "nextjs",
  detect(files) {
    return files.reduce((score, file) => {
      const name = (0, import_node_path4.basename)(file.relativePath);
      if (NEXT_MANIFESTS.has(name)) return score + 10;
      if (file.relativePath.includes("static/chunks/")) return score + 2;
      if (file.relativePath.includes("server/")) return score + 1;
      return score;
    }, 0);
  },
  classify(relativePath) {
    const name = (0, import_node_path4.basename)(relativePath);
    if (NEXT_MANIFESTS.has(name)) return "route-manifest";
    return classifyGeneric(relativePath);
  },
  async collectRoutes(context) {
    const routes = [];
    const findings = [];
    const budget = new AdapterBudget(context);
    for (const file of context.files.filter(
      (candidate) => candidate.kind === "route-manifest" && NEXT_MANIFESTS.has((0, import_node_path4.basename)(candidate.relativePath))
    )) {
      try {
        const value = JSON.parse(await context.readText(file));
        budget.inspectManifest(value, file.relativePath);
        collectNextRoutes(value, file, routes, budget);
      } catch (error) {
        rethrowOperationalError(error);
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

// src/adapters/vite.ts
var import_node_path5 = require("path");
var VITE_MANIFEST = ".vite/manifest.json";
function isHtml2(relativePath) {
  return (0, import_node_path5.extname)(relativePath.toLowerCase()) === ".html";
}
function routeForHtml2(relativePath) {
  return relativePath === "index.html" ? "/" : `/${encodeArtifactPath(relativePath)}`;
}
function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Manifest root must be an object");
  }
  for (const chunk of Object.values(value)) {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      throw new TypeError("Manifest chunks must be objects");
    }
    const output = chunk.file;
    if (typeof output !== "string" || output.length === 0) {
      throw new TypeError("Manifest chunks must name an output file");
    }
  }
}
var viteAdapter = {
  name: "vite",
  detect(files) {
    return files.reduce((score, file) => {
      if (file.relativePath === VITE_MANIFEST) return score + 20;
      if (isHtml2(file.relativePath)) return score + 3;
      if (file.relativePath.startsWith("assets/")) return score + 1;
      return score;
    }, 0);
  },
  classify(relativePath) {
    if (relativePath === VITE_MANIFEST || isHtml2(relativePath)) return "metadata";
    return classifyGeneric(relativePath);
  },
  async collectRoutes(context) {
    const routes = [];
    const budget = new AdapterBudget(context);
    for (const file of context.files.filter(
      (candidate) => isHtml2(candidate.relativePath)
    )) {
      budget.addRoute(routes, {
        route: routeForHtml2(file.relativePath),
        artifactPath: file.relativePath,
        pointer: "/",
        routeKind: "artifact-path"
      });
    }
    const findings = [];
    const manifest = context.files.find((file) => file.relativePath === VITE_MANIFEST);
    if (manifest) {
      try {
        const value = JSON.parse(await context.readText(manifest));
        budget.inspectManifest(value, manifest.relativePath);
        validateManifest(value);
      } catch (error) {
        rethrowOperationalError(error);
        findings.push({
          ruleId: "SG1004",
          severity: "error",
          category: "route",
          artifactPath: manifest.relativePath,
          message: "Vite manifest is malformed or unreadable",
          evidence: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { routes, findings };
  }
};

// src/adapters/index.ts
var adapters = [
  nextjsAdapter,
  astroAdapter,
  viteAdapter,
  genericAdapter
];
function strongAutoSignals(files) {
  const frameworks = [];
  if (files.some((file) => isNextManifest(file.relativePath))) frameworks.push("nextjs");
  if (files.some((file) => (0, import_node_path6.extname)(file.relativePath.toLowerCase()) === ".html") && files.some((file) => file.relativePath.startsWith("_astro/"))) {
    frameworks.push("astro");
  }
  if (files.some((file) => file.relativePath === ".vite/manifest.json")) {
    frameworks.push("vite");
  }
  const genericRouteManifest = files.some(
    (file) => !isNextManifest(file.relativePath) && genericAdapter.classify(file.relativePath) === "route-manifest"
  );
  return { frameworks, genericRouteManifest };
}
function selectAdapter(requested, files) {
  if (requested !== "auto") {
    const exact = adapters.find((adapter) => adapter.name === requested);
    if (!exact)
      throw new SurfaceGuardError("SG_CONFIG_INVALID", `Unknown adapter: ${requested}`);
    return exact;
  }
  const signals = strongAutoSignals(files);
  if (signals.frameworks.length > 1 || signals.genericRouteManifest && signals.frameworks.length > 0) {
    const conflicts = [
      ...signals.frameworks,
      ...signals.genericRouteManifest ? ["generic-route-manifest"] : []
    ];
    throw new SurfaceGuardError(
      "SG_CONFIG_INVALID",
      `Artifact contains conflicting adapter signals (${conflicts.join(", ")}); select an adapter explicitly`,
      { signals: conflicts }
    );
  }
  const strongFramework = signals.frameworks[0];
  if (strongFramework) {
    return adapters.find((adapter) => adapter.name === strongFramework) ?? genericAdapter;
  }
  if (signals.genericRouteManifest) return genericAdapter;
  return [...adapters].sort((left, right) => right.detect(files) - left.detect(files))[0] ?? genericAdapter;
}

// src/filesystem.ts
var import_node_fs = require("fs");
var import_promises2 = require("fs/promises");
var import_node_path7 = require("path");
var import_node_zlib = require("zlib");
function toPosixPath(value) {
  return value.split(import_node_path7.sep).join("/");
}
function isContained(root, candidate) {
  const child = (0, import_node_path7.relative)(root, candidate);
  return child === "" || !child.startsWith(`..${import_node_path7.sep}`) && child !== ".." && !(0, import_node_path7.isAbsolute)(child);
}
async function discoverFiles(inputRoot, limits, exclude, signal) {
  throwIfAborted(signal);
  const requestedRoot = (0, import_node_path7.resolve)(inputRoot);
  let rootStat;
  try {
    rootStat = await (0, import_promises2.lstat)(requestedRoot);
  } catch (error) {
    throwIfAborted(signal);
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
  throwIfAborted(signal);
  const files = [];
  const findings = [];
  let findingsTruncated = false;
  let findingsObserved = 0;
  let totalBytes = 0;
  let entriesVisited = 0;
  let directoriesVisited = 0;
  async function visit(directory, depth) {
    throwIfAborted(signal);
    if (depth > limits.maxDepth) {
      throw new SurfaceGuardError(
        "SG_RESOURCE_LIMIT",
        "Artifact directory depth exceeds maxDepth",
        {
          artifactPath: toPosixPath((0, import_node_path7.relative)(root, directory)) || ".",
          limit: limits.maxDepth,
          observed: depth
        }
      );
    }
    directoriesVisited += 1;
    if (directoriesVisited > limits.maxDirectories) {
      throw new SurfaceGuardError(
        "SG_RESOURCE_LIMIT",
        "Artifact directory count exceeds maxDirectories",
        {
          limit: limits.maxDirectories,
          observed: directoriesVisited
        }
      );
    }
    let handle;
    try {
      handle = await (0, import_promises2.opendir)(directory);
    } catch (error) {
      throwIfAborted(signal);
      throw new SurfaceGuardError(
        "SG_IO_ERROR",
        `Unable to read artifact directory: ${directory}`,
        {
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }
    const entries = [];
    for await (const entry of handle) {
      throwIfAborted(signal);
      entriesVisited += 1;
      if (entriesVisited > limits.maxEntries) {
        throw new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Artifact entry count exceeds maxEntries",
          {
            limit: limits.maxEntries,
            observed: entriesVisited
          }
        );
      }
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      const absolutePath = (0, import_node_path7.resolve)(directory, entry.name);
      const relativePath = toPosixPath((0, import_node_path7.relative)(root, absolutePath));
      if (!isContained(root, absolutePath)) {
        findingsObserved += 1;
        if (findings.length < limits.maxFindings) {
          findings.push({
            ruleId: "SG1001",
            severity: "error",
            category: "filesystem",
            artifactPath: relativePath,
            message: "Artifact path escapes the scan root"
          });
        } else findingsTruncated = true;
        continue;
      }
      if (exclude.some((pattern) => matchesGlob(relativePath, pattern))) continue;
      let stat;
      try {
        stat = await (0, import_promises2.lstat)(absolutePath);
      } catch (error) {
        throwIfAborted(signal);
        throw new SurfaceGuardError(
          "SG_IO_ERROR",
          `Unable to inspect artifact entry: ${relativePath}`,
          {
            cause: error instanceof Error ? error.message : String(error)
          }
        );
      }
      if (stat.isSymbolicLink()) {
        findingsObserved += 1;
        if (findings.length < limits.maxFindings) {
          findings.push({
            ruleId: "SG1002",
            severity: "error",
            category: "filesystem",
            artifactPath: relativePath,
            message: "Symbolic links are not followed inside artifact roots",
            evidence: relativePath,
            help: "Copy the intended artifact into the build directory as a regular file."
          });
        } else findingsTruncated = true;
        continue;
      }
      let resolvedEntry;
      try {
        resolvedEntry = await (0, import_promises2.realpath)(absolutePath);
      } catch (error) {
        throwIfAborted(signal);
        throw new SurfaceGuardError(
          "SG_IO_ERROR",
          `Unable to resolve artifact entry: ${relativePath}`,
          { cause: error instanceof Error ? error.message : String(error) }
        );
      }
      if (!isContained(root, resolvedEntry)) {
        findingsObserved += 1;
        if (findings.length < limits.maxFindings) {
          findings.push({
            ruleId: "SG1001",
            severity: "error",
            category: "filesystem",
            artifactPath: relativePath,
            message: "Artifact path resolves outside the scan root"
          });
        } else findingsTruncated = true;
        continue;
      }
      if (stat.isDirectory()) {
        await visit(resolvedEntry, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > limits.maxFileBytes) {
        throw new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Artifact file exceeds maxFileBytes",
          {
            artifactPath: relativePath,
            limit: limits.maxFileBytes,
            observed: stat.size
          }
        );
      }
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
        absolutePath: resolvedEntry,
        relativePath,
        kind: "unknown",
        size: stat.size,
        identity: {
          device: stat.dev,
          inode: stat.ino,
          modifiedMilliseconds: stat.mtimeMs,
          changedMilliseconds: stat.ctimeMs
        }
      });
    }
  }
  await visit(root, 0);
  return { root, files, findings, findingsTruncated, findingsObserved };
}
async function openArtifactStream(file, signal) {
  throwIfAborted(signal);
  if (!Number.isInteger(import_node_fs.constants.O_NOFOLLOW) || import_node_fs.constants.O_NOFOLLOW === 0) {
    throw new SurfaceGuardError(
      "SG_IO_ERROR",
      "This platform cannot open artifacts without following symbolic links",
      { artifactPath: file.relativePath }
    );
  }
  let handle;
  try {
    handle = await (0, import_promises2.open)(
      file.absolutePath,
      import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW
    );
    throwIfAborted(signal);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SurfaceGuardError(
        "SG_IO_ERROR",
        "Artifact changed to a non-regular file before it could be read",
        { artifactPath: file.relativePath }
      );
    }
    if (file.identity && (stat.dev !== file.identity.device || stat.ino !== file.identity.inode || stat.mtimeMs !== file.identity.modifiedMilliseconds || stat.ctimeMs !== file.identity.changedMilliseconds)) {
      throw new SurfaceGuardError(
        "SG_IO_ERROR",
        "Artifact changed after discovery and before it could be read",
        { artifactPath: file.relativePath }
      );
    }
    if (stat.size > file.size) {
      throw new SurfaceGuardError(
        "SG_RESOURCE_LIMIT",
        "Artifact grew beyond its discovered size before reading",
        {
          artifactPath: file.relativePath,
          limit: file.size,
          observed: stat.size
        }
      );
    }
    if (stat.size !== file.size) {
      throw new SurfaceGuardError(
        "SG_IO_ERROR",
        "Artifact size changed after discovery and before it could be read",
        {
          artifactPath: file.relativePath,
          expected: file.size,
          observed: stat.size
        }
      );
    }
    const stream = handle.createReadStream(
      signal ? { autoClose: false, highWaterMark: 64 * 1024, signal } : { autoClose: false, highWaterMark: 64 * 1024 }
    );
    return {
      handle,
      stream,
      identity: {
        device: stat.dev,
        inode: stat.ino,
        size: stat.size,
        modifiedMilliseconds: stat.mtimeMs,
        changedMilliseconds: stat.ctimeMs
      }
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => void 0);
    if (error instanceof SurfaceGuardError) throw error;
    throwIfAborted(signal);
    throw new SurfaceGuardError(
      "SG_IO_ERROR",
      `Unable to open artifact without following links: ${file.relativePath}`,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
}
function streamingError(error, file, operation, signal) {
  if (error instanceof SurfaceGuardError) return error;
  if (signal?.aborted) {
    return new SurfaceGuardError("SG_ABORTED", "Artifact scan was aborted");
  }
  return new SurfaceGuardError(
    "SG_IO_ERROR",
    operation === "read" ? `Unable to read artifact: ${file.relativePath}` : `Unable to expand gzip artifact: ${file.relativePath}`,
    { cause: error instanceof Error ? error.message : String(error) }
  );
}
async function closeArtifactStream(opened, file) {
  let verificationError;
  try {
    const stat = await opened.handle.stat();
    if (stat.dev !== opened.identity.device || stat.ino !== opened.identity.inode || stat.size !== opened.identity.size || stat.mtimeMs !== opened.identity.modifiedMilliseconds || stat.ctimeMs !== opened.identity.changedMilliseconds) {
      verificationError = new SurfaceGuardError(
        "SG_IO_ERROR",
        "Artifact changed while it was being read",
        { artifactPath: file.relativePath }
      );
    }
  } catch (error) {
    verificationError = new SurfaceGuardError(
      "SG_IO_ERROR",
      `Unable to verify artifact after reading: ${file.relativePath}`,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
  if (!opened.stream.readableEnded) opened.stream.destroy();
  let closeError;
  try {
    await opened.handle.close();
  } catch (error) {
    const code = error.code;
    if (!(opened.stream.destroyed && code === "EBADF")) {
      closeError = new SurfaceGuardError(
        "SG_IO_ERROR",
        `Unable to close artifact: ${file.relativePath}`,
        {
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }
  if (verificationError) throw verificationError;
  if (closeError) throw closeError;
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
  const opened = await openArtifactStream(file, signal);
  let operationError;
  try {
    for await (const chunk of opened.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observed += buffer.byteLength;
      if (observed > file.size || observed > limits.maxFileBytes) {
        throw new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Artifact grew beyond its discovered size while reading",
          {
            artifactPath: file.relativePath,
            limit: Math.min(file.size, limits.maxFileBytes),
            observed
          }
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    operationError = streamingError(error, file, "read", signal);
  }
  let closeError;
  try {
    await closeArtifactStream(opened, file);
  } catch (error) {
    closeError = error instanceof Error ? error : new SurfaceGuardError("SG_IO_ERROR", "Unable to close artifact", {
      cause: String(error)
    });
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  return decodeArtifactText(Buffer.concat(chunks), file.relativePath);
}
async function readGzipTextStreaming(file, maxOutputBytes, signal) {
  if (maxOutputBytes < 1) {
    throw new SurfaceGuardError(
      "SG_RESOURCE_LIMIT",
      "Expanded artifact bytes exceed limit",
      {
        artifactPath: file.relativePath,
        limit: Math.max(0, maxOutputBytes)
      }
    );
  }
  const chunks = [];
  let outputBytes = 0;
  const opened = await openArtifactStream(file, signal);
  const source = opened.stream;
  const gunzip = (0, import_node_zlib.createGunzip)();
  let operationError;
  let inputBytes = 0;
  source.on("data", (chunk) => {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes > file.size) {
      source.destroy(
        new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Compressed artifact grew beyond its discovered size while reading",
          {
            artifactPath: file.relativePath,
            limit: file.size,
            observed: inputBytes
          }
        )
      );
    }
  });
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > maxOutputBytes) {
        throw new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Expanded gzip artifact exceeds its output limit",
          {
            artifactPath: file.relativePath,
            limit: maxOutputBytes,
            observed: outputBytes
          }
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    operationError = streamingError(error, file, "expand", signal);
  }
  gunzip.destroy();
  let closeError;
  try {
    await closeArtifactStream(opened, file);
  } catch (error) {
    closeError = error instanceof Error ? error : new SurfaceGuardError("SG_IO_ERROR", "Unable to close artifact", {
      cause: String(error)
    });
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  return { ...decodeArtifactText(Buffer.concat(chunks), file.relativePath), outputBytes };
}
function declaredEncoding(relativePath, text) {
  const path = relativePath.toLowerCase().replace(/\.gz$/u, "");
  const head = text.slice(0, 8192);
  let match = null;
  if (path.endsWith(".html") || path.endsWith(".htm")) {
    match = /<meta\b[^>]{0,2048}\bcharset\s*=\s*["']?\s*([a-z0-9._-]+)/iu.exec(head);
  } else if (path.endsWith(".xml") || path.endsWith(".svg")) {
    match = /<\?xml\b[^?]{0,1024}\bencoding\s*=\s*["']\s*([^"'\s]{1,64})/iu.exec(head);
  } else if (path.endsWith(".css")) {
    match = /^\s*@charset\s+["']([^"']{1,64})["']/iu.exec(head);
  }
  return match?.[1]?.toLowerCase();
}
function supportsDeclaration(declared, encoding) {
  if (encoding === "utf-8") {
    return ["utf-8", "utf8", "us-ascii", "ascii"].includes(declared);
  }
  return declared === "utf-16" || declared === encoding;
}
function decodeArtifactText(buffer, relativePath) {
  const utf32LittleEndian = buffer[0] === 255 && buffer[1] === 254 && buffer[2] === 0 && buffer[3] === 0;
  const utf32BigEndian = buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 254 && buffer[3] === 255;
  if (utf32LittleEndian || utf32BigEndian) {
    return {
      text: new TextDecoder("utf-8").decode(buffer),
      encoding: "unsupported",
      valid: false,
      issue: "unsupported-bom"
    };
  }
  let encoding = "utf-8";
  if (buffer[0] === 255 && buffer[1] === 254) encoding = "utf-16le";
  if (buffer[0] === 254 && buffer[1] === 255) encoding = "utf-16be";
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    if (appearsBinary(text)) {
      return { text, encoding, valid: false, issue: "control-heavy" };
    }
    const declaration = declaredEncoding(relativePath, text);
    if (declaration && !supportsDeclaration(declaration, encoding)) {
      return { text, encoding, valid: false, issue: "unsupported-declaration" };
    }
    return { text, encoding, valid: true };
  } catch {
    return {
      text: new TextDecoder(encoding).decode(buffer),
      encoding,
      valid: false,
      issue: "invalid-sequence"
    };
  }
}
function appearsBinary(text) {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 9 || code > 13 && code < 32) return true;
  }
  return false;
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
    /&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);/giu,
    (match, name) => {
      const named = entities[name.toLowerCase()];
      if (named !== void 0) return named;
      const hexadecimal = name[1]?.toLowerCase() === "x";
      const digits = name.slice(hexadecimal ? 2 : 1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      const validXmlCharacter = codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32 && codePoint <= 55295 || codePoint >= 57344 && codePoint <= 65533 || codePoint >= 65536 && codePoint <= 1114111;
      return validXmlCharacter ? String.fromCodePoint(codePoint) : match;
    }
  );
}
function markupEnd(text, start, signal) {
  let quote;
  for (let index = start; index < text.length; index += 1) {
    if ((index & 4095) === 0) throwIfAborted(signal);
    const character = text[index];
    if (quote) {
      if (character === quote) quote = void 0;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}
function markupName(text, start, end) {
  let cursor = start + 1;
  if (text[cursor] === "/") cursor += 1;
  while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  const nameStart = cursor;
  while (cursor < end && !/[\s/>]/u.test(text[cursor] ?? "")) cursor += 1;
  return text.slice(nameStart, cursor);
}
function localName(name) {
  const separator = name.lastIndexOf(":");
  return name.slice(separator + 1).toLowerCase();
}
function selfClosingMarkup(text, start, end) {
  let cursor = end - 1;
  while (cursor > start && /\s/u.test(text[cursor] ?? "")) cursor -= 1;
  return text[cursor] === "/";
}
var VISIBLE_URL_SCHEME = /^[a-z][a-z\d+.-]*:/iu;
function robotsPathForSitemapLocation(value, maxDecodePasses) {
  const input2 = value.trim().replaceAll("\\", "/");
  let current = input2;
  for (let pass = 0; pass <= maxDecodePasses; pass += 1) {
    if (VISIBLE_URL_SCHEME.test(current) || current.startsWith("//")) {
      try {
        const url = current.startsWith("//") ? new URL(current, "https://surfaceguard.invalid") : new URL(current);
        return `${url.pathname}${url.search}`;
      } catch {
      }
    }
    if (pass === maxDecodePasses) break;
    const decoded = repeatedlyDecodeUrl(current, 1);
    if (decoded === current) break;
    current = decoded;
  }
  try {
    const relative2 = new URL(input2, "https://surfaceguard.invalid");
    return `${relative2.pathname}${relative2.search}`;
  } catch {
    return void 0;
  }
}
function parseSitemap(text, maxDecodePasses, options) {
  const routes = [];
  const robotsPaths = [];
  let entriesVisited = options.entriesVisited ?? 0;
  let cursor = 0;
  let openLocation;
  const visitLocation = (value) => {
    entriesVisited += 1;
    if (entriesVisited > options.maxEntries) {
      throw new SurfaceGuardError(
        "SG_RESOURCE_LIMIT",
        "Sitemap entry count exceeds maxSitemapEntries",
        {
          limit: options.maxEntries,
          observed: entriesVisited
        }
      );
    }
    const trimmed = value.trim();
    if (!trimmed) return;
    const robotsPath = robotsPathForSitemapLocation(trimmed, maxDecodePasses);
    if (robotsPath) robotsPaths.push(robotsPath);
    try {
      const canonical = canonicalizeUrl(trimmed, maxDecodePasses);
      const url = new URL(canonical, "https://surfaceguard.invalid");
      routes.push(`${url.pathname}${url.search}`);
    } catch {
    }
  };
  while (cursor < text.length) {
    throwIfAborted(options.signal);
    const tagStart = text.indexOf("<", cursor);
    if (tagStart < 0) {
      if (openLocation) openLocation.chunks.push(decodeXml(text.slice(cursor)));
      break;
    }
    if (openLocation && tagStart > cursor) {
      openLocation.chunks.push(decodeXml(text.slice(cursor, tagStart)));
    }
    if (text.startsWith("<!--", tagStart)) {
      const end = text.indexOf("-->", tagStart + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", tagStart)) {
      const end = text.indexOf("]]>", tagStart + 9);
      if (end < 0) break;
      if (openLocation) openLocation.chunks.push(text.slice(tagStart + 9, end));
      cursor = end + 3;
      continue;
    }
    if (text.startsWith("<?", tagStart)) {
      const end = text.indexOf("?>", tagStart + 2);
      if (end < 0) break;
      cursor = end + 2;
      continue;
    }
    if (text.slice(tagStart, tagStart + 9).toUpperCase() === "<!DOCTYPE") {
      throw new SurfaceGuardError(
        "SG_IO_ERROR",
        "Sitemap DOCTYPE declarations are unsupported",
        { reason: "External and custom XML entities are not expanded" }
      );
    }
    const tagEnd = markupEnd(text, tagStart + 1, options.signal);
    if (tagEnd < 0) break;
    const name = markupName(text, tagStart, tagEnd);
    const locationTag = localName(name) === "loc";
    const closing = text[tagStart + 1] === "/";
    const selfClosing = !closing && selfClosingMarkup(text, tagStart, tagEnd);
    if (locationTag) {
      if (closing && openLocation) {
        openLocation.depth -= 1;
        if (openLocation.depth === 0) {
          visitLocation(openLocation.chunks.join(""));
          openLocation = void 0;
        }
      } else if (!closing && selfClosing && !openLocation) {
        visitLocation("");
      } else if (!closing && !selfClosing) {
        if (openLocation) openLocation.depth += 1;
        else openLocation = { depth: 1, chunks: [] };
      }
    }
    cursor = tagEnd + 1;
  }
  return { routes, robotsPaths, entriesVisited };
}
function parseRobots(text, options = {}) {
  const rules = { disallow: [], sitemaps: [] };
  const maxRules = options.maxRules ?? Number.MAX_SAFE_INTEGER;
  const maxRuleLength = options.maxRuleLength ?? Number.MAX_SAFE_INTEGER;
  let rulesVisited = 0;
  const addRule = (kind, value) => {
    if (value.length > maxRuleLength) {
      throw new SurfaceGuardError(
        "SG_RESOURCE_LIMIT",
        "robots.txt directive exceeds maxPatternLength",
        { limit: maxRuleLength, observed: value.length }
      );
    }
    rulesVisited += 1;
    if (rulesVisited > maxRules) {
      throw new SurfaceGuardError(
        "SG_RESOURCE_LIMIT",
        "robots.txt directive count exceeds maxRobotsRules",
        { limit: maxRules, observed: rulesVisited }
      );
    }
    rules[kind].push(value);
  };
  let cursor = 0;
  while (cursor <= text.length) {
    throwIfAborted(options.signal);
    let end = cursor;
    while (end < text.length && text[end] !== "\r" && text[end] !== "\n") end += 1;
    const line = text.slice(cursor, end);
    const comment = line.indexOf("#");
    const withoutComment = line.slice(0, comment < 0 ? line.length : comment).trim();
    const separator = withoutComment.indexOf(":");
    if (separator >= 0) {
      const name = withoutComment.slice(0, separator).trim().toLowerCase();
      const value = withoutComment.slice(separator + 1).trim();
      if (name === "disallow" && value.startsWith("/")) addRule("disallow", value);
      if (name === "sitemap" && value) addRule("sitemaps", value);
    }
    if (end >= text.length) break;
    cursor = end + 1;
    if (text[end] === "\r" && text[cursor] === "\n") cursor += 1;
  }
  return rules;
}
function unreserved(byte) {
  return byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte === 45 || byte === 46 || byte === 95 || byte === 126;
}
function hexDigit(code) {
  if (code >= 48 && code <= 57) return code - 48;
  const folded = code | 32;
  return folded >= 97 && folded <= 102 ? folded - 87 : -1;
}
var ROBOTS_ENCODER = new TextEncoder();
function normalizeRobotsOctets(value) {
  let normalized = "";
  for (let index = 0; index < value.length; ) {
    const first = hexDigit(value.charCodeAt(index + 1));
    const second = hexDigit(value.charCodeAt(index + 2));
    if (value[index] === "%" && first >= 0 && second >= 0) {
      const byte = first << 4 | second;
      normalized += unreserved(byte) ? String.fromCodePoint(byte) : `%${byte.toString(16).padStart(2, "0").toUpperCase()}`;
      index += 3;
      continue;
    }
    const codePoint = value.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    if (codePoint <= 127) {
      normalized += character;
    } else {
      for (const byte of ROBOTS_ENCODER.encode(character)) {
        normalized += `%${byte.toString(16).padStart(2, "0").toUpperCase()}`;
      }
    }
    index += character.length;
  }
  return normalized;
}
function wildcardPrefixMatch(value, pattern, anchored) {
  const firstStar = pattern.indexOf("*");
  if (firstStar < 0) {
    return anchored ? value === pattern : value.startsWith(pattern);
  }
  const first = pattern.slice(0, firstStar);
  if (first && !value.startsWith(first)) return false;
  let cursor = first.length;
  let patternCursor = firstStar + 1;
  let nextStar = pattern.indexOf("*", patternCursor);
  while (nextStar >= 0) {
    const segment = pattern.slice(patternCursor, nextStar);
    if (segment) {
      const match = value.indexOf(segment, cursor);
      if (match < 0) return false;
      cursor = match + segment.length;
    }
    patternCursor = nextStar + 1;
    nextStar = pattern.indexOf("*", patternCursor);
  }
  const last = pattern.slice(patternCursor);
  if (anchored) {
    const match = value.length - last.length;
    return match >= cursor && value.startsWith(last, match);
  }
  return !last || value.includes(last, cursor);
}
function normalizeRobotsPath(pathAndQuery) {
  return normalizeRobotsOctets(pathAndQuery);
}
function compileRobotsRule(rule) {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  return { anchored, pattern: normalizeRobotsOctets(body) };
}
function matchesCompiledRobotsRule(normalizedPathAndQuery, rule) {
  return wildcardPrefixMatch(normalizedPathAndQuery, rule.pattern, rule.anchored);
}

// src/scan.ts
var SEVERITY_RANK2 = {
  note: 0,
  warning: 1,
  error: 2
};
var KNOWN_BINARY_EXTENSIONS = /* @__PURE__ */ new Set([
  ".7z",
  ".avi",
  ".avif",
  ".bin",
  ".bmp",
  ".br",
  ".eot",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".tar",
  ".tif",
  ".tiff",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip"
]);
function hasKnownBinaryExtension(file) {
  return KNOWN_BINARY_EXTENSIONS.has((0, import_node_path8.extname)(file.relativePath).toLowerCase());
}
function ambiguousUnknownLooksTextual(text) {
  let characters = 0;
  let textCharacters = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    characters += 1;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32 && codePoint <= 126 || codePoint >= 160 && codePoint !== 65533) {
      textCharacters += 1;
    }
  }
  return characters > 0 && textCharacters / characters >= 0.85;
}
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
    const route = normalizeRoute(
      evidence.route,
      evidence.routeKind === "artifact-path" ? 0 : maxDecodePasses
    );
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
function evaluateSitemap(policy, files, texts, routes, limits, signal) {
  const settings = policy.sitemap;
  if (!settings || settings.mode === "off") return [];
  const findings = [];
  const sitemapFiles = files.filter((file) => file.kind === "sitemap");
  const robotsFile = files.find(
    (file) => file.kind === "robots" && file.relativePath === "robots.txt"
  );
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
  const sitemapUrls = /* @__PURE__ */ new Map();
  let entriesVisited = 0;
  for (const file of sitemapFiles) {
    const text = texts.get(file.relativePath) ?? "";
    const parsed = parseSitemap(text, limits.maxDecodePasses, {
      maxEntries: limits.maxSitemapEntries,
      entriesVisited,
      ...signal ? { signal } : {}
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
  const robots = robotsFile ? parseRobots(texts.get(robotsFile.relativePath) ?? "", {
    maxRules: limits.maxRobotsRules ?? 5e4,
    maxRuleLength: limits.maxPatternLength,
    ...signal ? { signal } : {}
  }) : void 0;
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
  let robotsComparisons = 0;
  let robotsWork = 0;
  const maxRobotsComparisons = limits.maxRobotsComparisons ?? 1e6;
  const maxRobotsWork = limits.maxRobotsWork ?? 64 * 1024 * 1024;
  const compiledDisallow = (robots?.disallow ?? []).map(compileRobotsRule);
  const disallowedByRobots = (pathAndQuery) => {
    const normalizedPathAndQuery = normalizeRobotsPath(pathAndQuery);
    for (const pattern of compiledDisallow) {
      robotsComparisons += 1;
      robotsWork += normalizedPathAndQuery.length + pattern.pattern.length + 1;
      if ((robotsComparisons & 4095) === 0 && signal?.aborted) {
        throw new SurfaceGuardError("SG_ABORTED", "Artifact scan was aborted");
      }
      if (robotsComparisons > maxRobotsComparisons) {
        throw new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Sitemap and robots.txt comparisons exceed maxRobotsComparisons",
          { limit: maxRobotsComparisons, observed: robotsComparisons }
        );
      }
      if (robotsWork > maxRobotsWork) {
        throw new SurfaceGuardError(
          "SG_RESOURCE_LIMIT",
          "Sitemap and robots.txt matching exceeds maxRobotsWork",
          { limit: maxRobotsWork, observed: robotsWork }
        );
      }
      if (matchesCompiledRobotsRule(normalizedPathAndQuery, pattern)) return true;
    }
    return false;
  };
  for (const [pathAndQuery, artifactPath] of sitemapUrls) {
    if (disallowedByRobots(pathAndQuery)) {
      findings.push({
        ruleId: "SG4003",
        severity: "error",
        category: "sitemap",
        artifactPath,
        message: "Sitemap exposes a route disallowed by robots.txt",
        evidence: pathAndQuery
      });
    }
  }
  for (const [route, artifactPath] of sitemapRoutes) {
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
function encodingFinding(file) {
  return {
    ruleId: "SG1003",
    severity: "error",
    category: "filesystem",
    artifactPath: file.relativePath,
    message: "Text artifact uses an unsupported or ambiguous encoding",
    help: "Encode textual public artifacts as valid UTF-8 or BOM-tagged UTF-16LE/BE."
  };
}
var FindingCollector = class {
  constructor(maximum, failOn) {
    this.maximum = maximum;
    this.failOn = failOn;
  }
  maximum;
  failOn;
  findings = [];
  truncated = false;
  failureObserved = false;
  observedFindingsAtLeast = 0;
  add(finding) {
    this.observedFindingsAtLeast += 1;
    const rank = SEVERITY_RANK2[finding.severity];
    if (rank >= SEVERITY_RANK2[this.failOn]) this.failureObserved = true;
    if (this.findings.length < this.maximum) {
      this.findings.push(boundFindingEvidence(finding));
      return;
    }
    this.truncated = true;
    let lowest = this.findings.length - 1;
    for (let index = this.findings.length - 2; index >= 0; index -= 1) {
      if (SEVERITY_RANK2[this.findings[index]?.severity ?? "error"] < SEVERITY_RANK2[this.findings[lowest]?.severity ?? "error"]) {
        lowest = index;
      }
    }
    if (rank > SEVERITY_RANK2[this.findings[lowest]?.severity ?? "error"]) {
      this.findings[lowest] = boundFindingEvidence(finding);
    }
  }
  addAll(findings) {
    for (const finding of findings) this.add(finding);
  }
  observeOmitted(count, severity) {
    if (count <= 0) return;
    this.observedFindingsAtLeast += count;
    this.truncated = true;
    if (SEVERITY_RANK2[severity] >= SEVERITY_RANK2[this.failOn]) {
      this.failureObserved = true;
    }
  }
  matchLimit(severity) {
    const rank = SEVERITY_RANK2[severity];
    const freeSlots = this.maximum - this.findings.length;
    const replaceable = this.findings.filter(
      (finding) => SEVERITY_RANK2[finding.severity] < rank
    ).length;
    return Math.min(this.maximum + 1, Math.max(1, freeSlots + replaceable + 1));
  }
};
async function scanArtifacts(input2) {
  const policy = validatePolicy(input2.policy);
  const limits = resolveLimits(policy);
  const discovered = await discoverFiles(
    input2.root,
    limits,
    policy.exclude ?? [],
    input2.signal
  );
  const failOn = policy.failOn ?? "error";
  const collector = new FindingCollector(limits.maxFindings, failOn);
  collector.addAll(discovered.findings);
  collector.observeOmitted(
    discovered.findingsObserved - discovered.findings.length,
    "error"
  );
  if (discovered.findingsTruncated) collector.truncated = true;
  if (input2.signal?.aborted)
    throw new SurfaceGuardError("SG_ABORTED", "Artifact scan was aborted");
  const requestedAdapter = input2.adapter ?? policy.adapter ?? "auto";
  const adapter = selectAdapter(requestedAdapter, discovered.files);
  for (const file of discovered.files)
    file.kind = adapter.classify(file.relativePath) ?? "unknown";
  const texts = /* @__PURE__ */ new Map();
  const textValidity = /* @__PURE__ */ new Map();
  const unsupportedTextArtifacts = /* @__PURE__ */ new Set();
  const encodingFindings = /* @__PURE__ */ new Set();
  let expandedBytes = 0;
  const recordInvalidEncoding = (file) => {
    unsupportedTextArtifacts.add(file.relativePath);
    if (encodingFindings.has(file.relativePath)) return;
    encodingFindings.add(file.relativePath);
    collector.add(encodingFinding(file));
  };
  const readText = async (file, reportInvalidEncoding = true) => {
    const cached = texts.get(file.relativePath);
    if (cached !== void 0) {
      if (reportInvalidEncoding && textValidity.get(file.relativePath) === false && !encodingFindings.has(file.relativePath)) {
        recordInvalidEncoding(file);
      }
      return cached;
    }
    let text;
    let valid;
    if (file.kind === "sitemap" && file.relativePath.toLowerCase().endsWith(".gz")) {
      const remaining = limits.maxTotalBytes - expandedBytes;
      const expanded = await readGzipTextStreaming(
        file,
        Math.min(limits.maxFileBytes, remaining),
        input2.signal
      );
      text = expanded.text;
      valid = expanded.valid;
      expandedBytes += expanded.outputBytes;
    } else {
      const decoded = await readFileStreaming(file, limits, input2.signal);
      text = decoded.text;
      valid = decoded.valid;
    }
    textValidity.set(file.relativePath, valid);
    if (reportInvalidEncoding && !valid && !encodingFindings.has(file.relativePath)) {
      recordInvalidEncoding(file);
    }
    if (file.kind === "sitemap" || file.kind === "robots") {
      texts.set(file.relativePath, text);
    }
    return text;
  };
  const routeResult = await adapter.collectRoutes({
    root: discovered.root,
    files: discovered.files,
    readText,
    limits,
    ...input2.signal ? { signal: input2.signal } : {}
  });
  const evaluatedRoutes = evaluateRoutes(
    routeResult.routes,
    { ...input2, policy },
    limits.maxDecodePasses
  );
  collector.addAll(routeResult.findings);
  collector.addAll(evaluatedRoutes.findings);
  let filesScanned = 0;
  const unknownPatternRules = [
    ...policy.forbidden?.text ?? [],
    ...policy.forbidden?.endpoints ?? []
  ].filter(
    (rule) => !rule.scopes || rule.scopes.includes("all") || rule.scopes.includes("unknown")
  );
  const requiresUnknownInspection = unknownPatternRules.length > 0 || policy.sourceMaps?.mode === "forbid";
  const explicitUnknownInspection = unknownPatternRules.some(
    (rule) => rule.scopes?.includes("unknown")
  );
  for (const file of discovered.files) {
    if (input2.signal?.aborted)
      throw new SurfaceGuardError("SG_ABORTED", "Artifact scan was aborted");
    for (const rule of policy.forbidden?.files ?? []) {
      if (matchesGlob(file.relativePath, rule.glob)) {
        collector.add({
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
      collector.add({
        ruleId: "SG3001",
        severity: "error",
        category: "source-map",
        artifactPath: file.relativePath,
        message: "Source map file is forbidden by policy",
        evidence: (0, import_node_path8.basename)(file.relativePath)
      });
    }
    if (file.kind === "unknown" && !requiresUnknownInspection) {
      continue;
    }
    if (file.kind === "unknown" && hasKnownBinaryExtension(file) && !explicitUnknownInspection) {
      continue;
    }
    const text = await readText(file, file.kind !== "unknown");
    if (file.kind === "unknown" && textValidity.get(file.relativePath) === false) {
      unsupportedTextArtifacts.add(file.relativePath);
      if (explicitUnknownInspection || ambiguousUnknownLooksTextual(text)) {
        recordInvalidEncoding(file);
      }
    }
    filesScanned += 1;
    if (policy.sourceMaps?.mode === "forbid") {
      const directive = /[/#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/giu;
      const directiveLimit = collector.matchLimit("error");
      let directivesObserved = 0;
      let line = 1;
      let lineStart = 0;
      let locationCursor = 0;
      let match;
      while ((match = directive.exec(text)) !== null) {
        const inline = match[1]?.startsWith("data:") ?? false;
        if (inline && policy.sourceMaps.inline === "allow") continue;
        while (locationCursor < match.index) {
          const code = text.charCodeAt(locationCursor);
          if (code === 13) {
            if (text.charCodeAt(locationCursor + 1) === 10 && locationCursor + 1 < match.index) {
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
          ruleId: inline ? "SG3002" : "SG3003",
          severity: "error",
          category: "source-map",
          artifactPath: file.relativePath,
          message: inline ? "Inline source map is forbidden by policy" : "Source map reference is forbidden by policy",
          evidence: match[0],
          location: {
            line,
            column: match.index - lineStart + 1,
            offset: match.index
          }
        });
        directivesObserved += 1;
        if (directivesObserved >= directiveLimit) break;
      }
    }
    const groups = [
      ["text", policy.forbidden?.text ?? []],
      ["endpoint", policy.forbidden?.endpoints ?? []],
      ["metadata", file.kind === "metadata" ? policy.forbidden?.metadata ?? [] : []]
    ];
    for (const [category, rules] of groups) {
      for (const rule of rules) {
        const severity = rule.severity ?? "error";
        collector.addAll(
          matchPatternRule(text, file, rule, category, {
            ...limits,
            maxFindings: collector.matchLimit(severity)
          })
        );
      }
    }
  }
  for (const file of discovered.files.filter(
    (candidate) => candidate.kind === "sitemap" || candidate.kind === "robots"
  )) {
    if (!texts.has(file.relativePath)) await readText(file);
  }
  collector.addAll(
    evaluateSitemap(
      policy,
      discovered.files,
      texts,
      evaluatedRoutes.normalized,
      limits,
      input2.signal
    )
  );
  const sorted = sortFindings(collector.findings);
  const truncatedEvidence = sorted.filter((finding) => finding.evidenceTruncated).length;
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
      routesFound: evaluatedRoutes.normalized.size,
      findingsTruncated: collector.truncated
    },
    completeness: {
      textInspection: unsupportedTextArtifacts.size === 0 ? "complete" : "incomplete",
      findingDetails: collector.truncated ? "truncated" : "complete",
      findingLimit: limits.maxFindings,
      retainedFindings: sorted.length,
      observedFindingsAtLeast: collector.observedFindingsAtLeast,
      evidenceDetails: truncatedEvidence === 0 ? "complete" : "truncated",
      evidenceLimit: MAX_RETAINED_EVIDENCE_BYTES,
      truncatedEvidence,
      unsupportedTextArtifacts: unsupportedTextArtifacts.size
    },
    failed: collector.failureObserved
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
  if (adapterValue !== "auto" && adapterValue !== "astro" && adapterValue !== "generic" && adapterValue !== "nextjs" && adapterValue !== "vite") {
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
  await setOutput(
    "findings-truncated",
    String(result.completeness.findingDetails === "truncated")
  );
  await setOutput(
    "observed-findings-at-least",
    result.completeness.observedFindingsAtLeast.toString()
  );
  await setOutput("text-inspection", result.completeness.textInspection);
  await setOutput(
    "evidence-truncated",
    String((result.completeness.truncatedEvidence ?? 0) > 0)
  );
  await setOutput(
    "truncated-evidence",
    (result.completeness.truncatedEvidence ?? 0).toString()
  );
  await setOutput("failed", String(result.failed));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await (0, import_promises3.appendFile)(summaryPath, renderMarkdown(result), "utf8");
  for (const command of annotationCommands(result.findings)) {
    process.stdout.write(command);
  }
  if (result.failed) process.exitCode = 1;
}
run().catch((error) => {
  const message = error instanceof SurfaceGuardError ? JSON.stringify(error.toJSON()) : error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `::error::${commandData(boundOutputText(message, MAX_RETAINED_MESSAGE_BYTES))}
`
  );
  process.exitCode = 1;
});
