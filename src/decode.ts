export interface SourceSpan {
  start: number;
  end: number;
}

export interface DecodedText {
  text: string;
  spans: SourceSpan[];
  transform: string;
}

const IDENTITY_SPAN_VARIANTS = new WeakSet<DecodedText>();

function identitySpans(text: string): SourceSpan[] {
  return Array.from({ length: text.length }, (_, index) => ({
    start: index,
    end: index + 1,
  }));
}

function sourceSpanAt(input: DecodedText, index: number): SourceSpan | undefined {
  return IDENTITY_SPAN_VARIANTS.has(input)
    ? { start: index, end: index + 1 }
    : input.spans[index];
}

function decodeHexEscapes(input: DecodedText): DecodedText | undefined {
  if (!/\\(?:x[0-9a-f]{2}|u[0-9a-f]{4})/iu.test(input.text)) return undefined;
  let output = '';
  const spans: SourceSpan[] = [];
  let changed = false;

  for (let index = 0; index < input.text.length; index += 1) {
    const escaped = input.text[index] === '\\';
    const short = escaped ? /^\\x([0-9a-f]{2})/iu.exec(input.text.slice(index)) : null;
    const long = escaped ? /^\\u([0-9a-f]{4})/iu.exec(input.text.slice(index)) : null;
    const match = long ?? short;
    if (match?.[1]) {
      const width = match[0].length;
      output += String.fromCodePoint(Number.parseInt(match[1], 16));
      const first = sourceSpanAt(input, index);
      const last = sourceSpanAt(input, index + width - 1);
      if (first && last) spans.push({ start: first.start, end: last.end });
      index += width - 1;
      changed = true;
      continue;
    }
    output += input.text[index] ?? '';
    const span = sourceSpanAt(input, index);
    if (span) spans.push(span);
  }

  return changed
    ? { text: output, spans, transform: `${input.transform}+js-hex` }
    : undefined;
}

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  const folded = code | 32;
  return folded >= 97 && folded <= 102 ? folded - 87 : -1;
}

function isContinuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function isValidUtf8Scalar(bytes: Uint8Array, start: number, end: number): boolean {
  const length = end - start;
  const lead = bytes[start] ?? 0;
  if (length === 2) {
    return lead >= 0xc2 && lead <= 0xdf && isContinuation(bytes[start + 1] ?? 0);
  }
  if (length === 3 && isContinuation(bytes[start + 2] ?? 0)) {
    const second = bytes[start + 1] ?? 0;
    return (
      (lead === 0xe0 && second >= 0xa0 && second <= 0xbf) ||
      (lead >= 0xe1 && lead <= 0xec && isContinuation(second)) ||
      (lead === 0xed && second >= 0x80 && second <= 0x9f) ||
      (lead >= 0xee && lead <= 0xef && isContinuation(second))
    );
  }
  if (
    length === 4 &&
    isContinuation(bytes[start + 2] ?? 0) &&
    isContinuation(bytes[start + 3] ?? 0)
  ) {
    const second = bytes[start + 1] ?? 0;
    return (
      (lead === 0xf0 && second >= 0x90 && second <= 0xbf) ||
      (lead >= 0xf1 && lead <= 0xf3 && isContinuation(second)) ||
      (lead === 0xf4 && second >= 0x80 && second <= 0x8f)
    );
  }
  return false;
}

function utf8ScalarWidth(bytes: Uint8Array, start: number): number {
  const lead = bytes[start] ?? 0;
  if (lead <= 0x7f) return 1;
  for (const width of [2, 3, 4]) {
    if (start + width <= bytes.length && isValidUtf8Scalar(bytes, start, start + width)) {
      return width;
    }
  }
  return 0;
}

function utf8CodePoint(bytes: Uint8Array, start: number, width: number): number {
  const first = bytes[start] ?? 0;
  if (width === 1) return first;
  if (width === 2) return ((first & 0x1f) << 6) | ((bytes[start + 1] ?? 0) & 0x3f);
  if (width === 3) {
    return (
      ((first & 0x0f) << 12) |
      (((bytes[start + 1] ?? 0) & 0x3f) << 6) |
      ((bytes[start + 2] ?? 0) & 0x3f)
    );
  }
  return (
    ((first & 0x07) << 18) |
    (((bytes[start + 1] ?? 0) & 0x3f) << 12) |
    (((bytes[start + 2] ?? 0) & 0x3f) << 6) |
    ((bytes[start + 3] ?? 0) & 0x3f)
  );
}

function decodePercent(input: DecodedText): DecodedText | undefined {
  if (!/%[0-9a-f]{2}/iu.test(input.text)) return undefined;
  const output: string[] = [];
  const spans: SourceSpan[] = [];
  let changed = false;

  for (let index = 0; index < input.text.length;) {
    const first = hexNibble(input.text.charCodeAt(index + 1));
    const second = hexNibble(input.text.charCodeAt(index + 2));
    if (input.text[index] !== '%' || first < 0 || second < 0) {
      output.push(input.text[index] ?? '');
      const span = sourceSpanAt(input, index);
      if (span) spans.push(span);
      index += 1;
      continue;
    }

    const runStart = index;
    while (
      input.text[index] === '%' &&
      hexNibble(input.text.charCodeAt(index + 1)) >= 0 &&
      hexNibble(input.text.charCodeAt(index + 2)) >= 0
    ) {
      index += 3;
    }
    const runEnd = index;
    const bytes = new Uint8Array((runEnd - runStart) / 3);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      const raw = runStart + offset * 3;
      bytes[offset] =
        (hexNibble(input.text.charCodeAt(raw + 1)) << 4) |
        hexNibble(input.text.charCodeAt(raw + 2));
    }
    for (let byteIndex = 0; byteIndex < bytes.length;) {
      const firstWidth = utf8ScalarWidth(bytes, byteIndex);
      if (firstWidth === 0) {
        const rawStart = runStart + byteIndex * 3;
        for (let raw = rawStart; raw < rawStart + 3; raw += 1) {
          output.push(input.text[raw] ?? '');
          const span = sourceSpanAt(input, raw);
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
      const rawStart = runStart + segmentStart * 3;
      const rawEnd = runStart + segmentEnd * 3;
      const decodedFirst = sourceSpanAt(input, rawStart);
      const decodedLast = sourceSpanAt(input, rawEnd - 1);
      if (!decodedFirst || !decodedLast) continue;

      let scalar = segmentStart;
      let firstScalar = true;
      while (scalar < segmentEnd) {
        const width = utf8ScalarWidth(bytes, scalar);
        const codePoint = utf8CodePoint(bytes, scalar, width);
        scalar += width;
        if (firstScalar && codePoint === 0xfeff) {
          firstScalar = false;
          continue;
        }
        firstScalar = false;
        const decoded = String.fromCodePoint(codePoint);
        output.push(decoded);
        spans.push({ start: decodedFirst.start, end: decodedLast.end });
        if (decoded.length === 2) {
          spans.push({ start: decodedFirst.start, end: decodedLast.end });
        }
      }
      changed = true;
    }
  }

  return changed
    ? { text: output.join(''), spans, transform: `${input.transform}+percent` }
    : undefined;
}

function variantsForText(
  text: string,
  maxPasses: number,
  materializeIdentitySpans: boolean,
): DecodedText[] {
  const original: DecodedText = {
    text,
    spans: materializeIdentitySpans ? identitySpans(text) : [],
    transform: 'raw',
  };
  if (!materializeIdentitySpans) IDENTITY_SPAN_VARIANTS.add(original);
  const variants: DecodedText[] = [original];
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

export function decodeTextVariants(text: string, maxPasses: number): DecodedText[] {
  return variantsForText(text, maxPasses, true);
}

export function decodeTextVariantsForMatching(
  text: string,
  maxPasses: number,
): DecodedText[] {
  return variantsForText(text, maxPasses, false);
}

export function rawSpanForMatch(
  variant: DecodedText,
  start: number,
  length: number,
): SourceSpan | undefined {
  const first = sourceSpanAt(variant, start);
  const last = sourceSpanAt(variant, Math.max(start, start + length - 1));
  return first && last ? { start: first.start, end: last.end } : undefined;
}

function decodePercentText(text: string): string | undefined {
  if (!/%[0-9a-f]{2}/iu.test(text)) return undefined;
  const output: string[] = [];
  let changed = false;

  for (let index = 0; index < text.length;) {
    if (
      text[index] !== '%' ||
      hexNibble(text.charCodeAt(index + 1)) < 0 ||
      hexNibble(text.charCodeAt(index + 2)) < 0
    ) {
      output.push(text[index] ?? '');
      index += 1;
      continue;
    }

    const runStart = index;
    while (
      text[index] === '%' &&
      hexNibble(text.charCodeAt(index + 1)) >= 0 &&
      hexNibble(text.charCodeAt(index + 2)) >= 0
    ) {
      index += 3;
    }
    const bytes = new Uint8Array((index - runStart) / 3);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      const raw = runStart + offset * 3;
      bytes[offset] =
        (hexNibble(text.charCodeAt(raw + 1)) << 4) | hexNibble(text.charCodeAt(raw + 2));
    }

    for (let byteIndex = 0; byteIndex < bytes.length;) {
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
        if (firstScalar && codePoint === 0xfeff) {
          firstScalar = false;
          continue;
        }
        firstScalar = false;
        output.push(String.fromCodePoint(codePoint));
      }
      changed = true;
    }
  }

  return changed ? output.join('') : undefined;
}

export function repeatedlyDecodeUrl(value: string, maxPasses = 3): string {
  let current = value;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const decoded = decodePercentText(current);
    if (!decoded || decoded === current) break;
    current = decoded;
  }
  return current;
}

export function canonicalizeUrl(value: string, maxPasses = 3): string {
  const input = value.trim().replaceAll('\\', '/');
  const absolute = /^[a-z][a-z\d+.-]*:/iu.test(input);
  const url = new URL(input, 'https://surfaceguard.invalid');
  url.pathname = repeatedlyDecodeUrl(url.pathname, maxPasses)
    .replaceAll('\\', '/')
    .replace(/\/{2,}/gu, '/');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}
