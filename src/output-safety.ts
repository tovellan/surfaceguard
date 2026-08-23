import { createHash } from 'node:crypto';

import type { Finding } from './types.js';

export const MAX_RETAINED_EVIDENCE_BYTES = 2_048;
export const MAX_RETAINED_MESSAGE_BYTES = 2_048;
export const MAX_RETAINED_RULE_ID_BYTES = 255;
export const MAX_MARKDOWN_REPORT_BYTES = 900 * 1_024;

const BIDI_CONTROLS = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
  0x2069,
]);

function visibleEscape(codePoint: number): string {
  if (codePoint === 0x09) return '\\t';
  if (codePoint === 0x0a) return '\\n';
  if (codePoint === 0x0d) return '\\r';
  return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
}

export function printableText(value: string): string {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      BIDI_CONTROLS.has(codePoint)
    ) {
      output += visibleEscape(codePoint);
    } else {
      output += character;
    }
  }
  return output;
}

function isAsciiPunctuation(codePoint: number): boolean {
  return (
    (codePoint >= 0x21 && codePoint <= 0x2f) ||
    (codePoint >= 0x3a && codePoint <= 0x40) ||
    (codePoint >= 0x5b && codePoint <= 0x60) ||
    (codePoint >= 0x7b && codePoint <= 0x7e)
  );
}

export function markdownCell(value: string): string {
  let output = '';
  for (const character of printableText(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    output += isAsciiPunctuation(codePoint)
      ? `&#x${codePoint.toString(16).toUpperCase()};`
      : character;
  }
  return output;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > maximumBytes) break;
    bytes += width;
    end += character.length;
  }
  return value.slice(0, end);
}

export function boundOutputText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  const digest = createHash('sha256').update(value).digest('hex');
  const suffix = ` ... [truncated sha256:${digest}]`;
  const prefixBytes = Math.max(0, maximumBytes - Buffer.byteLength(suffix, 'utf8'));
  return `${utf8Prefix(value, prefixBytes)}${suffix}`;
}

export function boundFindingEvidence(finding: Finding): Finding {
  const ruleId = boundOutputText(finding.ruleId, MAX_RETAINED_RULE_ID_BYTES);
  const message = boundOutputText(finding.message, MAX_RETAINED_MESSAGE_BYTES);
  const bounded =
    ruleId === finding.ruleId && message === finding.message
      ? finding
      : { ...finding, ruleId, message };
  if (bounded.evidence === undefined) return bounded;
  const evidenceBytes = Buffer.byteLength(bounded.evidence, 'utf8');
  if (evidenceBytes <= MAX_RETAINED_EVIDENCE_BYTES) return bounded;
  return {
    ...bounded,
    evidence: utf8Prefix(bounded.evidence, MAX_RETAINED_EVIDENCE_BYTES),
    evidenceTruncated: true,
    evidenceBytes: bounded.evidenceBytes ?? evidenceBytes,
    evidenceSha256:
      bounded.evidenceSha256 ?? createHash('sha256').update(bounded.evidence).digest('hex'),
  };
}

export function displayEvidence(finding: Finding): string {
  const bounded = boundFindingEvidence(finding);
  const value = bounded.evidence ?? bounded.message;
  return bounded.evidenceTruncated
    ? `${value} ... [truncated from ${bounded.evidenceBytes ?? 'unknown'} UTF-8 bytes]`
    : value;
}

function encodeUriSegment(segment: string): string {
  let output = '';
  for (const byte of Buffer.from(segment, 'utf8')) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    output += unreserved
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return output;
}

export function relativeSarifUri(artifactPath: string): string {
  const encoded = artifactPath.split('/').map(encodeUriSegment).join('/');
  if (!encoded) return './';
  return encoded.startsWith('/') ? `.${encoded}` : encoded;
}
