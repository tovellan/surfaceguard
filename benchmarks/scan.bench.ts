import { bench, describe } from 'vitest';

import { decodeTextVariants } from '../src/decode.js';
import { matchPatternRule } from '../src/matcher.js';
import { DEFAULT_LIMITS } from '../src/constants.js';

const minified =
  `(()=>{const x="public";return x})()`.repeat(20_000) + '%252Fprivate-api%252F';
const malformedPercentRun = `${'%FF'.repeat(100_000)}%49`;
const file = {
  absolutePath: '/synthetic/app.js',
  relativePath: 'static/app.js',
  kind: 'client-chunk' as const,
  size: Buffer.byteLength(minified),
};

describe('bounded artifact operations', () => {
  bench('decode a minified client chunk', () => {
    decodeTextVariants(minified, 3);
  });

  bench('decode a long malformed percent run', () => {
    decodeTextVariants(malformedPercentRun, 1);
  });

  bench('match an encoded endpoint with evidence mapping', () => {
    matchPatternRule(
      minified,
      file,
      { id: 'private-endpoint', pattern: '/private-api/', match: 'literal' },
      'endpoint',
      DEFAULT_LIMITS,
    );
  });
});
