import { createReadStream } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { SurfaceGuardError } from './errors.js';
import { matchesGlob } from './glob.js';
import type { ArtifactFile, Finding, ScanLimits } from './types.js';

export function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

export function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  );
}

export async function discoverFiles(
  inputRoot: string,
  limits: ScanLimits,
  exclude: readonly string[],
): Promise<{ root: string; files: ArtifactFile[]; findings: Finding[] }> {
  const requestedRoot = resolve(inputRoot);
  let rootStat;
  try {
    rootStat = await lstat(requestedRoot);
  } catch (error) {
    throw new SurfaceGuardError(
      'SG_ROOT_INVALID',
      `Artifact root does not exist: ${requestedRoot}`,
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SurfaceGuardError(
      'SG_ROOT_INVALID',
      'Artifact root must be a real directory, not a symlink',
      {
        root: requestedRoot,
      },
    );
  }
  const root = await realpath(requestedRoot);
  const files: ArtifactFile[] = [];
  const findings: Finding[] = [];
  let totalBytes = 0;

  async function visit(directory: string): Promise<void> {
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      throw new SurfaceGuardError(
        'SG_IO_ERROR',
        `Unable to read artifact directory: ${directory}`,
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const entries = [];
    for await (const entry of handle) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = toPosixPath(relative(root, absolutePath));
      if (!isContained(root, absolutePath)) {
        if (findings.length < limits.maxFindings) {
          findings.push({
            ruleId: 'SG1001',
            severity: 'error',
            category: 'filesystem',
            artifactPath: relativePath,
            message: 'Artifact path escapes the scan root',
          });
        }
        continue;
      }
      if (exclude.some((pattern) => matchesGlob(relativePath, pattern))) continue;

      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        if (findings.length < limits.maxFindings) {
          findings.push({
            ruleId: 'SG1002',
            severity: 'error',
            category: 'filesystem',
            artifactPath: relativePath,
            message: 'Symbolic links are not followed inside artifact roots',
            evidence: relativePath,
            help: 'Copy the intended artifact into the build directory as a regular file.',
          });
        }
        continue;
      }
      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) continue;

      if (stat.size > limits.maxFileBytes) {
        throw new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Artifact file exceeds maxFileBytes',
          {
            artifactPath: relativePath,
            limit: limits.maxFileBytes,
            observed: stat.size,
          },
        );
      }
      if (files.length + 1 > limits.maxFiles) {
        throw new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Artifact file count exceeds maxFiles',
          {
            limit: limits.maxFiles,
          },
        );
      }
      totalBytes += stat.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Artifact bytes exceed maxTotalBytes',
          {
            limit: limits.maxTotalBytes,
            observed: totalBytes,
          },
        );
      }
      files.push({
        absolutePath,
        relativePath,
        kind: 'unknown',
        size: stat.size,
      });
    }
  }

  await visit(root);
  return { root, files, findings };
}

export async function readFileStreaming(
  file: ArtifactFile,
  limits: ScanLimits,
  signal?: AbortSignal,
): Promise<string> {
  if (file.size > limits.maxFileBytes) {
    throw new SurfaceGuardError('SG_RESOURCE_LIMIT', 'Artifact file exceeds maxFileBytes', {
      artifactPath: file.relativePath,
      limit: limits.maxFileBytes,
      observed: file.size,
    });
  }
  const chunks: Buffer[] = [];
  let observed = 0;
  const stream = createReadStream(file.absolutePath, { highWaterMark: 64 * 1024, signal });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      observed += buffer.byteLength;
      if (observed > limits.maxFileBytes) {
        stream.destroy();
        throw new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Artifact grew beyond maxFileBytes while reading',
          {
            artifactPath: file.relativePath,
            limit: limits.maxFileBytes,
          },
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof SurfaceGuardError) throw error;
    if (signal?.aborted) {
      throw new SurfaceGuardError('SG_ABORTED', 'Artifact scan was aborted');
    }
    throw new SurfaceGuardError(
      'SG_IO_ERROR',
      `Unable to read artifact: ${file.relativePath}`,
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function appearsBinary(text: string): boolean {
  const sample = text.slice(0, 8_192);
  if (sample.includes('\0')) return true;
  let controls = 0;
  for (const character of sample) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 9 || (code > 13 && code < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.05;
}
