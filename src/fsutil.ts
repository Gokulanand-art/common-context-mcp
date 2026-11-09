import * as fs from "node:fs";
import * as path from "node:path";

/** Deletes `${file}.${infix}-*` siblings beyond the newest `keep` (names sort chronologically). Best-effort. */
export function pruneSiblings(file: string, infix: string, keep: number): void {
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.${infix}-`;
    const matches = fs.readdirSync(dir).filter(f => f.startsWith(prefix)).sort();
    for (const f of matches.slice(0, Math.max(0, matches.length - keep))) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  } catch {}
}

/** Deletes crashed-write leftovers (`${file}.*.tmp`) older than `olderThanMs`. Best-effort. */
export function sweepStaleTmp(file: string, olderThanMs = 3_600_000): void {
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.`;
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith(".tmp")) continue;
      const p = path.join(dir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > olderThanMs) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}
