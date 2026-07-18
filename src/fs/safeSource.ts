import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isPathSafe } from './roots.js';

type ExpectedStat = { mtimeMs: number; size: number; dev?: number; ino?: number; ctimeMs?: number };

export function readBoundedSource(path: string, allowedRoots: string[], maxBytes: number, expected?: ExpectedStat): { content: string; stat: ExpectedStat } {
  if (!isPathSafe(path, allowedRoots) || lstatSync(path).isSymbolicLink()) throw new Error('unsafe source file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('source is not a regular file');
    if (before.size > maxBytes) throw new Error(`source exceeds ${maxBytes} byte limit`);
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || pathStat.dev !== before.dev || pathStat.ino !== before.ino) throw new Error('source changed before read');
    if (expected?.dev !== undefined && (expected.dev !== before.dev || expected.ino !== before.ino || expected.mtimeMs !== before.mtimeMs || expected.size !== before.size || expected.ctimeMs !== before.ctimeMs)) {
      throw new Error('source changed after discovery');
    }

    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (bytes === 0) break;
      offset += bytes;
    }
    if (offset !== buffer.length || readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error('source changed during read');

    const after = fstatSync(fd);
    const finalPathStat = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        finalPathStat.isSymbolicLink() || finalPathStat.dev !== before.dev || finalPathStat.ino !== before.ino || !isPathSafe(path, allowedRoots)) {
      throw new Error('source changed during read');
    }
    return { content: buffer.toString('utf8'), stat: { mtimeMs: after.mtimeMs, size: after.size, dev: after.dev, ino: after.ino, ctimeMs: after.ctimeMs } };
  } finally {
    closeSync(fd);
  }
}
