import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { canonicalizeUrl, decodeTextVariants, repeatedlyDecodeUrl } from '../src/decode.js';
import { matchesRobotsRule, parseRobots, parseSitemap } from '../src/sitemap.js';

describe('URL decoding and canonicalization', () => {
  it('decodes repeated percent encoding with a configured bound', () => {
    expect(repeatedlyDecodeUrl('%252Fprivate%252Fpath', 2)).toBe('/private/path');
    expect(repeatedlyDecodeUrl('%252Fprivate%252Fpath', 1)).toBe('%2Fprivate%2Fpath');
    expect(repeatedlyDecodeUrl('%49%4E%54%45%52%4E%41%4C%5F%4F%4E%4C%59%FF', 1)).toBe(
      'INTERNAL_ONLY%FF',
    );
  });

  it('canonicalizes paths and absolute URLs', () => {
    expect(canonicalizeUrl('/a//b/../c#fragment')).toBe('/a/c');
    expect(canonicalizeUrl('//private')).toBe('/private');
    expect(canonicalizeUrl('///private')).toBe('/private');
    expect(canonicalizeUrl('HTTPS://PUBLIC.EXAMPLE:443/a')).toBe(
      'https://public.example/a',
    );
    expect(canonicalizeUrl('/docs/a%23b%3Fc.html')).toBe('/docs/a%23b%3Fc.html');
    expect(canonicalizeUrl('%252Fprivate')).toBe('/private');
    expect(canonicalizeUrl('/%2Fprivate%FF')).toBe('/private%FF');
  });

  it('recognizes bounded percent-encoded absolute URLs before parsing structure', () => {
    expect(canonicalizeUrl('https%3A%2F%2Fpublic.example%2Fprivate')).toBe(
      'https://public.example/private',
    );
    expect(canonicalizeUrl('https%253A%252F%252Fpublic.example%252Fprivate')).toBe(
      'https://public.example/private',
    );
    expect(canonicalizeUrl('https%3A%252F%252Fpublic.example%252Fprivate')).toBe(
      'https://public.example/private',
    );
    expect(canonicalizeUrl('https:%2F%2Fpublic.example%2Fprivate')).toBe(
      'https://public.example/private',
    );
    expect(
      canonicalizeUrl('https%3A%2F%2Fpublic.example%2Fdocs%2Fa%2523b%253Fc.html'),
    ).toBe('https://public.example/docs/a%23b%3Fc.html');
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

  it('decodes JavaScript code-point escapes with exact raw spans', () => {
    const source = '\\u{1F600}\\u{49}NTERNAL_ONLY';
    const decoded = decodeTextVariants(source, 3).at(-1);
    expect(decoded?.text).toBe('😀INTERNAL_ONLY');
    expect(decoded?.spans.slice(0, 2)).toEqual([
      { start: 0, end: 9 },
      { start: 0, end: 9 },
    ]);
    expect(source.slice(decoded?.spans[2]?.start, decoded?.spans[2]?.end)).toBe('\\u{49}');
  });

  it.each([
    ['%41%42', 'AB', 0, 3],
    ['%C3%A9%41', 'éA', 0, 6],
    ['%F0%9F%98%80%41', '😀A', 0, 12],
    ['%FF%C3%A9', '%FFé', 3, 9],
    ['%C3%A9%FF%49', 'é%FFI', 9, 12],
    ['%E2%28%A1%41', '%E2(%A1A', 9, 12],
    ['%EF%BB%BF%41', 'A', 9, 12],
  ])('decodes valid UTF-8 segments in %s', (source, expected, decodedStart, decodedEnd) => {
    const decoded = decodeTextVariants(source, 1).at(-1);
    expect(decoded?.text).toBe(expected);
    const firstChanged =
      decoded?.spans.findIndex((span) => span.start === decodedStart) ?? -1;
    expect(firstChanged).toBeGreaterThanOrEqual(0);
    expect(decoded?.spans[firstChanged]).toEqual({
      start: decodedStart,
      end: decodedEnd,
    });
  });

  it('maps each decoded scalar to only its own percent-encoded bytes', () => {
    const decoded = decodeTextVariants('%41%42%41', 1).at(-1);
    expect(decoded?.text).toBe('ABA');
    expect(decoded?.spans).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 9 },
    ]);
  });

  it('decodes long malformed percent runs without retrying suffixes', () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      const source = `${'%FF'.repeat(4_096)}%41`;
      expect(decodeTextVariants(source, 1).at(-1)?.text).toBe(`${'%FF'.repeat(4_096)}A`);
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it('matches a segmented fatal-decoder oracle for arbitrary percent bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 32 }), (bytes) => {
        const source = [...bytes]
          .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
          .join('');
        const widthAt = (index: number): number => {
          const lead = bytes[index] ?? 0;
          if (lead <= 0x7f) return 1;
          const width =
            lead >= 0xc2 && lead <= 0xdf
              ? 2
              : lead >= 0xe0 && lead <= 0xef
                ? 3
                : lead >= 0xf0 && lead <= 0xf4
                  ? 4
                  : 0;
          if (width === 0 || index + width > bytes.length) return 0;
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(
              bytes.subarray(index, index + width),
            );
            return width;
          } catch {
            return 0;
          }
        };
        let expected = '';
        for (let index = 0; index < bytes.length;) {
          const width = widthAt(index);
          if (width === 0) {
            expected += source.slice(index * 3, index * 3 + 3);
            index += 1;
            continue;
          }
          const segmentStart = index;
          index += width;
          while (index < bytes.length) {
            const nextWidth = widthAt(index);
            if (nextWidth === 0) break;
            index += nextWidth;
          }
          expected += new TextDecoder('utf-8', { fatal: true }).decode(
            bytes.subarray(segmentStart, index),
          );
        }
        const variants = decodeTextVariants(source, 1);
        expect(variants.at(-1)?.text).toBe(expected);
        if (expected === source) expect(variants).toHaveLength(1);
      }),
      { numRuns: 1_000 },
    );
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

  it('decodes XML entities once without turning nested escapes into markup', () => {
    const sitemap =
      '<urlset><url><loc>https://public.example/docs?value=one&amp;lt;two&amp;next=ok</loc></url></urlset>';
    expect(parseSitemap(sitemap, 3, { maxEntries: 10 }).routes).toEqual([
      '/docs?value=one&lt;two&next=ok',
    ]);
  });

  it('decodes decimal and hexadecimal XML character references once', () => {
    const sitemap =
      '<urlset><url><loc>https://public.example/&#x70;riv&#97;te</loc></url></urlset>';
    expect(parseSitemap(sitemap, 3, { maxEntries: 10 }).routes).toEqual(['/private']);
  });

  it('does not decode invalid or nested XML character references', () => {
    const sitemap = [
      '<urlset>',
      '<url><loc>https://public.example/&amp;#x70;rivate</loc></url>',
      '<url><loc>https://public.example/&#xD800;private</loc></url>',
      '<url><loc>https://public.example/&#x110000;private</loc></url>',
      '</urlset>',
    ].join('');
    expect(parseSitemap(sitemap, 3, { maxEntries: 10 }).routes).not.toContain('/private');
  });

  it('reads namespaced location text across comments, processing instructions, and CDATA', () => {
    const sitemap = [
      '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '<sm:url><sm:loc marker=">">https://public.example/pri',
      '<!-- ignored --><?ignored value?><![CDATA[vate]]>',
      '</sm:loc></sm:url></sm:urlset>',
    ].join('');
    expect(parseSitemap(sitemap, 3, { maxEntries: 10 })).toEqual({
      routes: ['/private'],
      robotsPaths: ['/private'],
      entriesVisited: 1,
    });
  });

  it('preserves reserved percent octets for robots reconciliation', () => {
    const sitemap =
      '<urlset><url><loc>https://public.example/encoded%2Fslash?q=a%2Fb</loc></url></urlset>';
    expect(parseSitemap(sitemap, 3, { maxEntries: 10 })).toMatchObject({
      routes: ['/encoded/slash?q=a%2Fb'],
      robotsPaths: ['/encoded%2Fslash?q=a%2Fb'],
    });
  });

  it('fails closed on sitemap DOCTYPE declarations that could define custom entities', () => {
    const sitemap = [
      '<!DOCTYPE urlset [<!ENTITY private "private">]>',
      '<urlset><url><loc>https://public.example/&private;</loc></url></urlset>',
    ].join('');
    expect(() => parseSitemap(sitemap, 3, { maxEntries: 10 })).toThrow(
      expect.objectContaining({ code: 'SG_IO_ERROR' }),
    );
  });

  it.each([
    ['/privateer', '/private'],
    ['/private', '/private$'],
    ['/percent', '/%70ercent'],
    ['/search?private=1', '/search?private=1'],
    ['/query?token=value', '/query?token=%76alue$'],
    ['/wild/nested/end', '/wild*end$'],
  ])('matches robots path %s against %s', (pathAndQuery, rule) => {
    expect(matchesRobotsRule(pathAndQuery, rule)).toBe(true);
  });

  it.each([
    ['/private/child', '/private$'],
    ['/encoded/slash', '/encoded%2Fslash'],
    ['/wild/nested/end/more', '/wild*end$'],
  ])('does not match robots path %s against %s', (pathAndQuery, rule) => {
    expect(matchesRobotsRule(pathAndQuery, rule)).toBe(false);
  });

  it('parses a long blank robots file without materializing all lines', () => {
    expect(parseRobots('\n'.repeat(1_000_000))).toEqual({
      disallow: [],
      sitemaps: [],
    });
  });

  it('parses bare CR, LF, and CRLF robots line endings', () => {
    expect(
      parseRobots(
        'User-agent: *\rDisallow: /bare-cr\nDisallow: /lf\r\nSitemap: /sitemap.xml',
      ),
    ).toEqual({
      disallow: ['/bare-cr', '/lf'],
      sitemaps: ['/sitemap.xml'],
    });
  });

  it('bounds retained robots directives', () => {
    expect(() => parseRobots('Disallow: /one\nDisallow: /two', { maxRules: 1 })).toThrow(
      expect.objectContaining({ code: 'SG_RESOURCE_LIMIT' }),
    );
  });

  it('bounds robots directive length before retaining or comparing it', () => {
    expect(() =>
      parseRobots(`Disallow: /${'x'.repeat(20)}`, { maxRuleLength: 10 }),
    ).toThrow(expect.objectContaining({ code: 'SG_RESOURCE_LIMIT' }));
  });

  it('scans malformed repeated sitemap tags in one forward pass', () => {
    expect(parseSitemap('<loc>'.repeat(20_000), 3, { maxEntries: 20_000 })).toEqual({
      routes: [],
      robotsPaths: [],
      entriesVisited: 0,
    });
  });
});
