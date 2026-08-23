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

function decodePercent(input: DecodedText): DecodedText | undefined {
  if (!/%[0-9a-f]{2}/iu.test(input.text)) return undefined;
  let output = '';
  const spans: SourceSpan[] = [];
  let changed = false;

  for (let index = 0; index < input.text.length; index += 1) {
    const match =
      input.text[index] === '%'
        ? /^(?:%[0-9a-f]{2})+/iu.exec(input.text.slice(index))
        : null;
    if (!match) {
      output += input.text[index] ?? '';
      const span = sourceSpanAt(input, index);
      if (span) spans.push(span);
      continue;
    }

    const bytes = match[0]
      .split('%')
      .slice(1)
      .map((value) => Number.parseInt(value, 16));
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      output += input.text[index] ?? '';
      const span = sourceSpanAt(input, index);
      if (span) spans.push(span);
      continue;
    }

    const first = sourceSpanAt(input, index);
    const last = sourceSpanAt(input, index + match[0].length - 1);
    if (!first || !last) continue;
    for (const character of decoded) {
      output += character;
      spans.push({ start: first.start, end: last.end });
      if (character.length === 2) spans.push({ start: first.start, end: last.end });
    }
    index += match[0].length - 1;
    changed = true;
  }

  return changed
    ? { text: output, spans, transform: `${input.transform}+percent` }
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

export function repeatedlyDecodeUrl(value: string, maxPasses = 3): string {
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

export function canonicalizeUrl(value: string, maxPasses = 3): string {
  const decoded = repeatedlyDecodeUrl(value.trim(), maxPasses).replaceAll('\\', '/');
  const absolute = /^[a-z][a-z\d+.-]*:/iu.test(decoded);
  const url = new URL(decoded, 'https://surfaceguard.invalid');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  url.pathname = url.pathname.replace(/\/{2,}/gu, '/');
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}
