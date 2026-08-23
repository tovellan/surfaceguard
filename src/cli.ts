#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { VERSION } from './constants.js';
import { SurfaceGuardError } from './errors.js';
import { loadPolicy } from './policy.js';
import { renderJson, renderMarkdown, renderSarif } from './reporters/index.js';
import { scanArtifacts } from './scan.js';

type Format = 'json' | 'markdown' | 'sarif';
type Adapter = 'auto' | 'generic' | 'nextjs' | 'vite';

interface ParsedScan {
  root: string;
  policy: string;
  format: Format;
  output?: string;
  adapter?: Adapter;
}

const EXAMPLE_POLICY = {
  schemaVersion: 1,
  adapter: 'auto',
  failOn: 'error',
  routes: {
    allow: ['/**'],
    deny: ['/staff/**'],
  },
  sourceMaps: {
    mode: 'forbid',
    inline: 'forbid',
  },
  forbidden: {
    text: [
      {
        id: 'organization-internal-text',
        pattern: 'INTERNAL_ONLY',
        match: 'literal',
        scopes: ['all'],
      },
    ],
    endpoints: [
      {
        id: 'private-endpoint',
        pattern: '/internal-api/',
        match: 'literal',
      },
    ],
    files: [
      {
        id: 'environment-file',
        glob: '**/.env*',
      },
    ],
  },
  sitemap: {
    mode: 'if-present',
    requireRobotsReference: true,
    forbidDisallowedRoutes: true,
  },
};

function help(): string {
  return `SurfaceGuard ${VERSION}

Usage:
  surfaceguard scan <artifact-dir> --policy <policy.json> [options]
  surfaceguard validate-policy <policy.json>
  surfaceguard init [--output surfaceguard.policy.json]

Scan options:
  --adapter <auto|generic|nextjs|vite>  Override framework detection
  --format <json|markdown|sarif>    Report format (default: markdown)
  --output <path>                   Write report to a file instead of stdout
  --policy <path>                   Versioned SurfaceGuard policy

Exit codes:
  0  Scan passed or command completed
  1  Findings met the policy failure threshold
  2  Configuration, input, or runtime error
`;
}

function takeValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `${option} requires a value`);
  }
  return value;
}

function parseScan(args: string[]): ParsedScan {
  const root = args[0];
  if (!root || root.startsWith('-')) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', 'scan requires an artifact directory');
  }
  let policy: string | undefined;
  let format: Format = 'markdown';
  let output: string | undefined;
  let adapter: Adapter | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--policy') {
      policy = takeValue(args, index, option);
      index += 1;
    } else if (option === '--format') {
      const value = takeValue(args, index, option);
      if (!['json', 'markdown', 'sarif'].includes(value)) {
        throw new SurfaceGuardError('SG_CONFIG_INVALID', `Unsupported format: ${value}`);
      }
      format = value as Format;
      index += 1;
    } else if (option === '--output') {
      output = takeValue(args, index, option);
      index += 1;
    } else if (option === '--adapter') {
      const value = takeValue(args, index, option);
      if (!['auto', 'generic', 'nextjs', 'vite'].includes(value)) {
        throw new SurfaceGuardError('SG_CONFIG_INVALID', `Unsupported adapter: ${value}`);
      }
      adapter = value as Adapter;
      index += 1;
    } else {
      throw new SurfaceGuardError('SG_CONFIG_INVALID', `Unknown option: ${option}`);
    }
  }
  if (!policy) throw new SurfaceGuardError('SG_CONFIG_INVALID', '--policy is required');
  return {
    root,
    policy,
    format,
    ...(output ? { output } : {}),
    ...(adapter ? { adapter } : {}),
  };
}

async function run(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(help());
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'validate-policy') {
    const path = args[0];
    if (!path)
      throw new SurfaceGuardError('SG_CONFIG_INVALID', 'validate-policy requires a path');
    await loadPolicy(path);
    process.stdout.write(`${resolve(path)}: valid\n`);
    return 0;
  }
  if (command === 'init') {
    let output = 'surfaceguard.policy.json';
    if (args[0] === '--output') output = takeValue(args, 0, '--output');
    else if (args.length > 0)
      throw new SurfaceGuardError('SG_CONFIG_INVALID', `Unknown option: ${args[0] ?? ''}`);
    await writeFile(output, `${JSON.stringify(EXAMPLE_POLICY, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${resolve(output)}: created\n`);
    return 0;
  }
  if (command !== 'scan')
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `Unknown command: ${command}`);

  const options = parseScan(args);
  const policy = await loadPolicy(options.policy);
  const result = await scanArtifacts({
    root: options.root,
    policy,
    ...(options.adapter ? { adapter: options.adapter } : {}),
  });
  const report =
    options.format === 'json'
      ? renderJson(result)
      : options.format === 'sarif'
        ? renderSarif(result)
        : renderMarkdown(result);
  if (options.output) await writeFile(options.output, report, 'utf8');
  else process.stdout.write(report);
  return result.failed ? 1 : 0;
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const normalized =
      error instanceof SurfaceGuardError
        ? error
        : new SurfaceGuardError(
            'SG_IO_ERROR',
            error instanceof Error ? error.message : String(error),
          );
    process.stderr.write(`${JSON.stringify(normalized.toJSON())}\n`);
    process.exitCode = 2;
  });
