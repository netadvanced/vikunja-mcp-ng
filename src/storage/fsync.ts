/**
 * Durability helper shared by this directory's write-temp-then-rename
 * helpers (`writeVaultFileAtomic`, `writeTemplatesFileAtomic`).
 *
 * `writeFileSync` followed by `renameSync` is *atomic* — a reader never sees
 * a half-written file — but atomic is not the same as *durable*. Both calls
 * return once the change is in the OS page cache, so a power loss or a hard
 * container kill shortly after a "successful" write can leave the renamed
 * file empty, truncated, or missing entirely: the caller was told the
 * credential/template was stored, and after the reboot it is gone
 * (issue #293 / LOW-10).
 *
 * `fsync(2)` on the temp file before the rename, and on the containing
 * directory after it, is what closes that window.
 */

import * as fs from 'node:fs';

/**
 * `fsync(2)` whatever `target` names — a file (`flags: 'r+'`) or a directory
 * (`flags: 'r'`) — always closing the descriptor, including on failure.
 *
 * Throws whatever `openSync`/`fsyncSync` throws. Callers decide whether that
 * is fatal: for the temp file it should be (the rename has not happened yet,
 * so the previous good file is still intact and failing loudly is honest),
 * while a directory fsync is best-effort because opening a directory is not
 * portable.
 */
export function fsyncPath(target: string, flags: 'r' | 'r+'): void {
  const fd = fs.openSync(target, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
