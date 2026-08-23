import { rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const target = resolve('dist');
if (basename(target) !== 'dist') throw new Error('Refusing to clean an unexpected path');
await rm(target, { recursive: true, force: true });
