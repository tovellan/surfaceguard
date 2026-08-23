import { extname } from 'node:path';

import { classifyGeneric } from './generic.js';
import type {
  AdapterContext,
  ArtifactKind,
  Finding,
  FrameworkAdapter,
  RouteEvidence,
} from '../types.js';

const VITE_MANIFEST = '.vite/manifest.json';

function isHtml(relativePath: string): boolean {
  return extname(relativePath.toLowerCase()) === '.html';
}

function routeForHtml(relativePath: string): string {
  return relativePath === 'index.html' ? '/' : `/${relativePath}`;
}

function validateManifest(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Manifest root must be an object');
  }
  for (const chunk of Object.values(value as Record<string, unknown>)) {
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
      throw new TypeError('Manifest chunks must be objects');
    }
    const output = (chunk as Record<string, unknown>).file;
    if (typeof output !== 'string' || output.length === 0) {
      throw new TypeError('Manifest chunks must name an output file');
    }
  }
}

export const viteAdapter: FrameworkAdapter = {
  name: 'vite',
  detect(files): number {
    return files.reduce((score, file) => {
      if (file.relativePath === VITE_MANIFEST) return score + 20;
      if (isHtml(file.relativePath)) return score + 3;
      if (file.relativePath.startsWith('assets/')) return score + 1;
      return score;
    }, 0);
  },
  classify(relativePath: string): ArtifactKind | undefined {
    if (relativePath === VITE_MANIFEST || isHtml(relativePath)) return 'metadata';
    return classifyGeneric(relativePath);
  },
  async collectRoutes(context: AdapterContext): Promise<{
    routes: RouteEvidence[];
    findings: Finding[];
  }> {
    const routes = context.files
      .filter((file) => isHtml(file.relativePath))
      .map((file) => ({
        route: routeForHtml(file.relativePath),
        artifactPath: file.relativePath,
        pointer: '/',
      }));
    const findings: Finding[] = [];
    const manifest = context.files.find((file) => file.relativePath === VITE_MANIFEST);
    if (manifest) {
      try {
        validateManifest(JSON.parse(await context.readText(manifest)) as unknown);
      } catch (error) {
        findings.push({
          ruleId: 'SG1004',
          severity: 'error',
          category: 'route',
          artifactPath: manifest.relativePath,
          message: 'Vite manifest is malformed or unreadable',
          evidence: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { routes, findings };
  },
};
