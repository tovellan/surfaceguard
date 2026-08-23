export function encodeArtifactPath(relativePath: string): string {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}
