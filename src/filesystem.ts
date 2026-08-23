import { constants as fileConstants, type Dirent, type ReadStream } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

import { SurfaceGuardError, throwIfAborted } from './errors.js';
import { matchesGlob } from './glob.js';
import type { ArtifactFile, Finding, ScanLimits } from './types.js';

export interface ArtifactText {
  text: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'unsupported';
  valid: boolean;
  issue?:
    'invalid-sequence' | 'control-heavy' | 'unsupported-bom' | 'unsupported-declaration';
}

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
  signal?: AbortSignal,
): Promise<{
  root: string;
  files: ArtifactFile[];
  findings: Finding[];
  findingsTruncated: boolean;
  findingsObserved: number;
}> {
  throwIfAborted(signal);
  const requestedRoot = resolve(inputRoot);
  let rootStat;
  try {
    rootStat = await lstat(requestedRoot);
  } catch (error) {
    throwIfAborted(signal);
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
  throwIfAborted(signal);
  const files: ArtifactFile[] = [];
  const findings: Finding[] = [];
  let findingsTruncated = false;
  let findingsObserved = 0;
  let totalBytes = 0;
  let entriesVisited = 0;
  let directoriesVisited = 0;

  async function visit(directory: string, depth: number): Promise<void> {
    throwIfAborted(signal);
    if (depth > limits.maxDepth) {
      throw new SurfaceGuardError(
        'SG_RESOURCE_LIMIT',
        'Artifact directory depth exceeds maxDepth',
        {
          artifactPath: toPosixPath(relative(root, directory)) || '.',
          limit: limits.maxDepth,
          observed: depth,
        },
      );
    }
    directoriesVisited += 1;
    if (directoriesVisited > limits.maxDirectories) {
      throw new SurfaceGuardError(
        'SG_RESOURCE_LIMIT',
        'Artifact directory count exceeds maxDirectories',
        {
          limit: limits.maxDirectories,
          observed: directoriesVisited,
        },
      );
    }
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      throwIfAborted(signal);
      throw new SurfaceGuardError(
        'SG_IO_ERROR',
        `Unable to read artifact directory: ${directory}`,
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const entries: Dirent[] = [];
    for await (const entry of handle) {
      throwIfAborted(signal);
      entriesVisited += 1;
      if (entriesVisited > limits.maxEntries) {
        throw new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Artifact entry count exceeds maxEntries',
          {
            limit: limits.maxEntries,
            observed: entriesVisited,
          },
        );
      }
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      throwIfAborted(signal);
      const absolutePath = resolve(directory, entry.name);
      const relativePath = toPosixPath(relative(root, absolutePath));
      if (!isContained(root, absolutePath)) {
        findingsObserved += 1;
        if (findings.length < limits.maxFindings) {
          findings.push({
            ruleId: 'SG1001',
            severity: 'error',
            category: 'filesystem',
            artifactPath: relativePath,
            message: 'Artifact path escapes the scan root',
          });
        } else findingsTruncated = true;
        continue;
      }
      if (exclude.some((pattern) => matchesGlob(relativePath, pattern))) continue;

      let stat;
      try {
        stat = await lstat(absolutePath);
      } catch (error) {
        throwIfAborted(signal);
        throw new SurfaceGuardError(
          'SG_IO_ERROR',
          `Unable to inspect artifact entry: ${relativePath}`,
          {
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      if (stat.isSymbolicLink()) {
        findingsObserved += 1;
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
        } else findingsTruncated = true;
        continue;
      }
      let resolvedEntry: string;
      try {
        resolvedEntry = await realpath(absolutePath);
      } catch (error) {
        throwIfAborted(signal);
        throw new SurfaceGuardError(
          'SG_IO_ERROR',
          `Unable to resolve artifact entry: ${relativePath}`,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      if (!isContained(root, resolvedEntry)) {
        findingsObserved += 1;
        if (findings.length < limits.maxFindings) {
          findings.push({
            ruleId: 'SG1001',
            severity: 'error',
            category: 'filesystem',
            artifactPath: relativePath,
            message: 'Artifact path resolves outside the scan root',
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
        absolutePath: resolvedEntry,
        relativePath,
        kind: 'unknown',
        size: stat.size,
        identity: {
          device: stat.dev,
          inode: stat.ino,
          modifiedMilliseconds: stat.mtimeMs,
          changedMilliseconds: stat.ctimeMs,
        },
      });
    }
  }

  await visit(root, 0);
  return { root, files, findings, findingsTruncated, findingsObserved };
}

interface OpenedArtifactStream {
  handle: FileHandle;
  stream: ReadStream;
  identity: {
    device: number;
    inode: number;
    size: number;
    modifiedMilliseconds: number;
    changedMilliseconds: number;
  };
}

async function openArtifactStream(
  file: ArtifactFile,
  signal?: AbortSignal,
): Promise<OpenedArtifactStream> {
  throwIfAborted(signal);
  if (!Number.isInteger(fileConstants.O_NOFOLLOW) || fileConstants.O_NOFOLLOW === 0) {
    throw new SurfaceGuardError(
      'SG_IO_ERROR',
      'This platform cannot open artifacts without following symbolic links',
      { artifactPath: file.relativePath },
    );
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      file.absolutePath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
    throwIfAborted(signal);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SurfaceGuardError(
        'SG_IO_ERROR',
        'Artifact changed to a non-regular file before it could be read',
        { artifactPath: file.relativePath },
      );
    }
    if (
      file.identity &&
      (stat.dev !== file.identity.device ||
        stat.ino !== file.identity.inode ||
        stat.mtimeMs !== file.identity.modifiedMilliseconds ||
        stat.ctimeMs !== file.identity.changedMilliseconds)
    ) {
      throw new SurfaceGuardError(
        'SG_IO_ERROR',
        'Artifact changed after discovery and before it could be read',
        { artifactPath: file.relativePath },
      );
    }
    if (stat.size > file.size) {
      throw new SurfaceGuardError(
        'SG_RESOURCE_LIMIT',
        'Artifact grew beyond its discovered size before reading',
        {
          artifactPath: file.relativePath,
          limit: file.size,
          observed: stat.size,
        },
      );
    }
    if (stat.size !== file.size) {
      throw new SurfaceGuardError(
        'SG_IO_ERROR',
        'Artifact size changed after discovery and before it could be read',
        {
          artifactPath: file.relativePath,
          expected: file.size,
          observed: stat.size,
        },
      );
    }
    const stream = handle.createReadStream(
      signal
        ? { autoClose: false, highWaterMark: 64 * 1024, signal }
        : { autoClose: false, highWaterMark: 64 * 1024 },
    );
    return {
      handle,
      stream,
      identity: {
        device: stat.dev,
        inode: stat.ino,
        size: stat.size,
        modifiedMilliseconds: stat.mtimeMs,
        changedMilliseconds: stat.ctimeMs,
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (error instanceof SurfaceGuardError) throw error;
    throwIfAborted(signal);
    throw new SurfaceGuardError(
      'SG_IO_ERROR',
      `Unable to open artifact without following links: ${file.relativePath}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function streamingError(
  error: unknown,
  file: ArtifactFile,
  operation: 'read' | 'expand',
  signal?: AbortSignal,
): SurfaceGuardError {
  if (error instanceof SurfaceGuardError) return error;
  if (signal?.aborted) {
    return new SurfaceGuardError('SG_ABORTED', 'Artifact scan was aborted');
  }
  return new SurfaceGuardError(
    'SG_IO_ERROR',
    operation === 'read'
      ? `Unable to read artifact: ${file.relativePath}`
      : `Unable to expand gzip artifact: ${file.relativePath}`,
    { cause: error instanceof Error ? error.message : String(error) },
  );
}

async function closeArtifactStream(
  opened: OpenedArtifactStream,
  file: ArtifactFile,
): Promise<void> {
  let verificationError: Error | undefined;
  try {
    const stat = await opened.handle.stat();
    if (
      stat.dev !== opened.identity.device ||
      stat.ino !== opened.identity.inode ||
      stat.size !== opened.identity.size ||
      stat.mtimeMs !== opened.identity.modifiedMilliseconds ||
      stat.ctimeMs !== opened.identity.changedMilliseconds
    ) {
      verificationError = new SurfaceGuardError(
        'SG_IO_ERROR',
        'Artifact changed while it was being read',
        { artifactPath: file.relativePath },
      );
    }
  } catch (error) {
    verificationError = new SurfaceGuardError(
      'SG_IO_ERROR',
      `Unable to verify artifact after reading: ${file.relativePath}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!opened.stream.readableEnded) opened.stream.destroy();
  let closeError: Error | undefined;
  try {
    await opened.handle.close();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(opened.stream.destroyed && code === 'EBADF')) {
      closeError = new SurfaceGuardError(
        'SG_IO_ERROR',
        `Unable to close artifact: ${file.relativePath}`,
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  if (verificationError) throw verificationError;
  if (closeError) throw closeError;
}

export async function readFileStreaming(
  file: ArtifactFile,
  limits: ScanLimits,
  signal?: AbortSignal,
): Promise<ArtifactText> {
  if (file.size > limits.maxFileBytes) {
    throw new SurfaceGuardError('SG_RESOURCE_LIMIT', 'Artifact file exceeds maxFileBytes', {
      artifactPath: file.relativePath,
      limit: limits.maxFileBytes,
      observed: file.size,
    });
  }
  const chunks: Buffer[] = [];
  let observed = 0;
  const opened = await openArtifactStream(file, signal);
  let operationError: SurfaceGuardError | undefined;
  try {
    for await (const chunk of opened.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      observed += buffer.byteLength;
      if (observed > file.size || observed > limits.maxFileBytes) {
        throw new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Artifact grew beyond its discovered size while reading',
          {
            artifactPath: file.relativePath,
            limit: Math.min(file.size, limits.maxFileBytes),
            observed,
          },
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    operationError = streamingError(error, file, 'read', signal);
  }
  let closeError: Error | undefined;
  try {
    await closeArtifactStream(opened, file);
  } catch (error) {
    closeError =
      error instanceof Error
        ? error
        : new SurfaceGuardError('SG_IO_ERROR', 'Unable to close artifact', {
            cause: String(error),
          });
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  return decodeArtifactText(Buffer.concat(chunks), file.relativePath);
}

export async function readGzipTextStreaming(
  file: ArtifactFile,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<ArtifactText & { outputBytes: number }> {
  if (maxOutputBytes < 1) {
    throw new SurfaceGuardError(
      'SG_RESOURCE_LIMIT',
      'Expanded artifact bytes exceed limit',
      {
        artifactPath: file.relativePath,
        limit: Math.max(0, maxOutputBytes),
      },
    );
  }
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  const opened = await openArtifactStream(file, signal);
  const source = opened.stream;
  const gunzip = createGunzip();
  let operationError: SurfaceGuardError | undefined;
  let inputBytes = 0;
  source.on('data', (chunk: Buffer | string) => {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes > file.size) {
      source.destroy(
        new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Compressed artifact grew beyond its discovered size while reading',
          {
            artifactPath: file.relativePath,
            limit: file.size,
            observed: inputBytes,
          },
        ),
      );
    }
  });
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      outputBytes += buffer.byteLength;
      if (outputBytes > maxOutputBytes) {
        throw new SurfaceGuardError(
          'SG_RESOURCE_LIMIT',
          'Expanded gzip artifact exceeds its output limit',
          {
            artifactPath: file.relativePath,
            limit: maxOutputBytes,
            observed: outputBytes,
          },
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    operationError = streamingError(error, file, 'expand', signal);
  }
  gunzip.destroy();
  let closeError: Error | undefined;
  try {
    await closeArtifactStream(opened, file);
  } catch (error) {
    closeError =
      error instanceof Error
        ? error
        : new SurfaceGuardError('SG_IO_ERROR', 'Unable to close artifact', {
            cause: String(error),
          });
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  return { ...decodeArtifactText(Buffer.concat(chunks), file.relativePath), outputBytes };
}

function declaredEncoding(relativePath: string, text: string): string | undefined {
  const path = relativePath.toLowerCase().replace(/\.gz$/u, '');
  const head = text.slice(0, 8_192);
  let match: RegExpExecArray | null = null;
  if (path.endsWith('.html') || path.endsWith('.htm')) {
    match = /<meta\b[^>]{0,2048}\bcharset\s*=\s*["']?\s*([a-z0-9._-]+)/iu.exec(head);
  } else if (path.endsWith('.xml') || path.endsWith('.svg')) {
    match = /<\?xml\b[^?]{0,1024}\bencoding\s*=\s*["']\s*([^"'\s]{1,64})/iu.exec(head);
  } else if (path.endsWith('.css')) {
    match = /^\s*@charset\s+["']([^"']{1,64})["']/iu.exec(head);
  }
  return match?.[1]?.toLowerCase();
}

function supportsDeclaration(
  declared: string,
  encoding: Exclude<ArtifactText['encoding'], 'unsupported'>,
): boolean {
  if (encoding === 'utf-8') {
    return ['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(declared);
  }
  return declared === 'utf-16' || declared === encoding;
}

function decodeArtifactText(buffer: Buffer, relativePath: string): ArtifactText {
  const utf32LittleEndian =
    buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00;
  const utf32BigEndian =
    buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff;
  if (utf32LittleEndian || utf32BigEndian) {
    return {
      text: new TextDecoder('utf-8').decode(buffer),
      encoding: 'unsupported',
      valid: false,
      issue: 'unsupported-bom',
    };
  }

  let encoding: ArtifactText['encoding'] = 'utf-8';
  if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = 'utf-16le';
  if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = 'utf-16be';

  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    if (appearsBinary(text)) {
      return { text, encoding, valid: false, issue: 'control-heavy' };
    }
    const declaration = declaredEncoding(relativePath, text);
    if (declaration && !supportsDeclaration(declaration, encoding)) {
      return { text, encoding, valid: false, issue: 'unsupported-declaration' };
    }
    return { text, encoding, valid: true };
  } catch {
    return {
      text: new TextDecoder(encoding).decode(buffer),
      encoding,
      valid: false,
      issue: 'invalid-sequence',
    };
  }
}

export function appearsBinary(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 9 || (code > 13 && code < 32)) return true;
  }
  return false;
}
