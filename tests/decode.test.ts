import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { canonicalizeUrl, decodeTextVariants, repeatedlyDecodeUrl } from '../src/decode.js';

describe('URL decoding and canonicalization', () => {
  it('decodes repeated percent encoding with a configured bound', () => {
    expect(repeatedlyDecodeUrl('%252Fprivate%252Fpath', 2)).toBe('/private/path');
    expect(repeatedlyDecodeUrl('%252Fprivate%252Fpath', 1)).toBe('%2Fprivate%2Fpath');
  });

  it('canonicalizes paths and absolute URLs', () => {
    expect(canonicalizeUrl('/a//b/../c#fragment')).toBe('/a/c');
    expect(canonicalizeUrl('HTTPS://PUBLIC.EXAMPLE:443/a')).toBe(
      'https://public.example/a',
    );
  });

  it('preserves raw source spans through JavaScript and percent decoding', () => {
    const source = 'x="\\x2fprivate%252dapi%252f"';
    const variants = decodeTextVariants(source, 2);
    expect(variants.at(-1)?.text).toContain('/private-api/');
    const slash = variants
      .at(-1)
      ?.spans.find((span, index) => variants.at(-1)?.text[index] === '/');
    expect(source.slice(slash?.start, slash?.end)).toBe('\\x2f');
  });

  it('is idempotent for canonical paths', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/u), { minLength: 1, maxLength: 8 }),
        (segments) => {
          const path = `/${segments.join('/')}`;
          expect(canonicalizeUrl(canonicalizeUrl(path))).toBe(canonicalizeUrl(path));
        },
      ),
    );
  });
});
