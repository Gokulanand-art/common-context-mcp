import * as fs from "node:fs";
import * as http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { pruneSiblings } from "./fsutil.js";
// Type-only: the store calls into this module at runtime, so a value import would cycle.
import type { ContextStore } from "./store.js";

const SCOPES = ["https://www.googleapis.com/auth/drive.appdata"];

/** Resolved lazily: os.homedir() throws when HOME is undeterminable, which must not break startup. */
function homeDir(): string {
  try {
    return os.homedir();
  } catch {
    return os.tmpdir();
  }
}

const tokenFile = (): string => path.join(homeDir(), ".config", "common-context-mcp", "google-tokens.json");
const oauthEnvCandidates = (): string[] => [
  path.join(homeDir(), ".aura", "google-oauth.env"),
  path.join(homeDir(), ".config", "common-context-mcp", "oauth.env"),
];

/** Every Drive/OAuth request carries this deadline: a stalled network must never hang a tool. */
export const FETCH_TIMEOUT_MS = 20_000;

export async function timedFetch(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expiry_date: number;
  token_type?: string;
  scope?: string;
}

function readEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(p, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch {}
  return out;
}

export function loadOAuthConfig(): OAuthConfig | null {
  const env = process.env;
  let clientId = env.GOOGLE_CLIENT_ID || env.AURA_GOOGLE_CLIENT_ID;
  let clientSecret = env.GOOGLE_CLIENT_SECRET || env.AURA_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    for (const p of oauthEnvCandidates()) {
      const f = readEnvFile(p);
      clientId = clientId || f.AURA_GOOGLE_CLIENT_ID || f.GOOGLE_CLIENT_ID;
      clientSecret = clientSecret || f.AURA_GOOGLE_CLIENT_SECRET || f.GOOGLE_CLIENT_SECRET;
      if (clientId && clientSecret) break;
    }
  }
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function loadTokens(): Tokens | null {
  try {
    const raw = fs.readFileSync(tokenFile(), "utf-8");
    const t = JSON.parse(raw) as Tokens;
    if (!t.access_token) return null;
    return t;
  } catch {
    return null;
  }
}

export function saveTokens(t: Tokens): void {
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(t, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function clearTokens(): void {
  try { fs.unlinkSync(tokenFile()); } catch {}
}

export function isLoggedIn(): boolean {
  return loadTokens() !== null;
}

async function refreshAccessToken(cfg: OAuthConfig, tokens: Tokens): Promise<Tokens> {
  if (!tokens.refresh_token) throw new Error("no refresh_token; run `common-context-mcp login` again");
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await timedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`token refresh failed: ${json.error_description || json.error || res.status}`);
  const updated: Tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || tokens.refresh_token,
    expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
    token_type: json.token_type,
    scope: json.scope || tokens.scope,
  };
  saveTokens(updated);
  return updated;
}

/** Serializes token refresh across processes: concurrent refreshers could strand a rotated refresh token. */
async function acquireTokenLock(): Promise<() => void> {
  const lockFile = `${tokenFile()}.lock`;
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  } catch {}
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(lockFile, "utf-8").trim() === token) fs.unlinkSync(lockFile);
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > 30_000) {
        fs.unlinkSync(lockFile);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the token lock");
    await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
  }
}

let refreshInflight: Promise<Tokens> | null = null;

async function lockedRefresh(cfg: OAuthConfig, tokens: Tokens): Promise<Tokens> {
  if (!refreshInflight) {
    refreshInflight = (async () => {
      const release = await acquireTokenLock();
      try {
        // Another process may have refreshed while we waited; adopt its token.
        const cur = loadTokens();
        if (cur && cur.access_token !== tokens.access_token && cur.expiry_date > Date.now() + 60_000) return cur;
        const latest = cur ?? tokens;
        return await refreshAccessToken(cfg, {
          ...latest,
          refresh_token: latest.refresh_token ?? tokens.refresh_token,
        });
      } finally {
        release();
        refreshInflight = null;
      }
    })();
  }
  return refreshInflight;
}

export async function getAccessToken(force = false): Promise<string> {
  const cfg = loadOAuthConfig();
  if (!cfg) throw new Error("Google OAuth not configured. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or create ~/.aura/google-oauth.env");
  let tokens = loadTokens();
  if (!tokens) throw new Error("Not logged in. Run `common-context-mcp login`.");
  if (force || !(tokens.expiry_date > 0) || Date.now() > tokens.expiry_date - 60_000) {
    tokens = await lockedRefresh(cfg, tokens);
  }
  return tokens.access_token;
}

/**
 * Authenticated Drive call with one recovery attempt: on 401/403 the token is force-refreshed
 * and the request retried once. Covers revoked tokens whose expiry is still in the future.
 */
async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const attempt = (token: string): Promise<Response> =>
    timedFetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    });
  let res = await attempt(await getAccessToken());
  if (res.status === 401 || res.status === 403) {
    let token: string;
    try {
      token = await getAccessToken(true);
    } catch (e) {
      throw new Error(
        `Drive rejected the stored token and refresh failed (${(e as Error).message}); run \`common-context-mcp login\` again`
      );
    }
    res = await attempt(token);
  }
  return res;
}

export function buildAuthUrl(cfg: OAuthConfig, redirectUri: string, state: string): string {
  return (
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString()
  );
}

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Extracts the auth code from the loopback callback; rejects errors, missing codes, state mismatch. */
export function parseAuthCallback(reqUrl: string, expectedState: string): string {
  const u = new URL(reqUrl, "http://127.0.0.1");
  const err = u.searchParams.get("error");
  if (err) throw new Error(err);
  const code = u.searchParams.get("code");
  if (!code) throw new Error("missing code");
  if (u.searchParams.get("state") !== expectedState) {
    throw new Error("state mismatch (possible CSRF); aborting login");
  }
  return code;
}

/** How to open a URL on each platform. win32 needs cmd because start is a shell builtin. */
export function openCommand(platform: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", ""] };
  return { cmd: "xdg-open", args: [] };
}

export async function login(): Promise<void> {
  const cfg = loadOAuthConfig();
  if (!cfg) throw new Error("Google OAuth not configured. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or create ~/.aura/google-oauth.env");

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const addr = server.address() as { port: number };
  const port = addr.port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const state = randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl(cfg, redirectUri, state);

  const codePromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("login timed out (5 min)")), 5 * 60_000);
    server.on("request", (req, res) => {
      const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (u.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      let code: string;
      try {
        code = parseAuthCallback(req.url || "/", state);
      } catch (e) {
        const msg = (e as Error).message;
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html");
        res.end(`<h1>Login failed</h1><p>${escHtml(msg)}</p>`);
        clearTimeout(timeout);
        reject(new Error(msg));
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end(`<!DOCTYPE html><html><head><title>Signed in</title><style>body{font-family:system-ui;background:#0a0a0a;color:#f5f5f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}h1{color:#c8ff00}</style></head><body><div><h1>✓ Signed in</h1><p>You can close this tab and return to the terminal.</p></div></body></html>`);
      clearTimeout(timeout);
      resolve(code);
    });
  });

  try {
    const { spawn } = await import("node:child_process");
    const o = openCommand(process.platform);
    const child = spawn(o.cmd, [...o.args, authUrl], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // no browser installed: the printed URL below is the fallback
    child.unref();
  } catch {}

  process.stdout.write(`\nOpening browser for Google sign-in...\nIf it doesn't open, visit:\n${authUrl}\n\n`);

  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await timedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`token exchange failed: ${json.error_description || json.error || res.status}`);

  const tokens: Tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
    token_type: json.token_type,
    scope: json.scope,
  };
  if (!tokens.refresh_token) {
    const existing = loadTokens();
    if (existing?.refresh_token) tokens.refresh_token = existing.refresh_token;
  }
  saveTokens(tokens);
  process.stdout.write(`✓ Logged in. Tokens stored at ${tokenFile()}\n`);
}

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export interface DriveFileMeta {
  id: string;
  name: string;
  modifiedTime: string;
}

export async function findDriveFile(name: string): Promise<DriveFileMeta | null> {
  const q = encodeURIComponent(`name='${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed=false`);
  const url = `${DRIVE_API}/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)&pageSize=10`;
  const res = await driveFetch(url);
  if (!res.ok) throw new Error(`drive list failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as any;
  const files = ((json.files || []) as DriveFileMeta[]).sort(
    (a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime)
  );
  // Simultaneous first-pushes can create same-named duplicates. Newest-wins is deterministic,
  // so machines converge instead of flapping between copies. Extras are left alone (deleting
  // user data automatically is worse); they show up in listSyncedRemotes.
  return files.length ? files[0] : null;
}

/** Refuses absurd downloads before they can OOM a tool call. */
export const MAX_REMOTE_BYTES = 64 * 1024 * 1024;

export async function readCappedText(res: Response, maxBytes = MAX_REMOTE_BYTES): Promise<string> {
  const len = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(len) && len > maxBytes) throw new Error(`remote file too large (${len} bytes)`);
  const body = res.body as unknown as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null;
  if (!body || typeof body.getReader !== "function") {
    const t = await res.text();
    if (t.length > maxBytes) throw new Error("remote file too large");
    return t;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new Error("remote file too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function downloadDriveFile(id: string): Promise<string> {
  const res = await driveFetch(`${DRIVE_API}/files/${id}?alt=media`);
  if (!res.ok) throw new Error(`drive download failed: ${res.status} ${await res.text()}`);
  return readCappedText(res);
}

/** Pre-3.6.0 shared remote. Left orphaned on Drive; listed (never auto-deleted) by listSyncedRemotes. */
export const LEGACY_REMOTE_NAME = "common-context.json";

/** Every common-context remote in the appDataFolder, newest first — reveals divergent project identities. */
export async function listSyncedRemotes(): Promise<DriveFileMeta[]> {
  const q = encodeURIComponent(
    `(name contains 'common-context--' or name = '${LEGACY_REMOTE_NAME}') and trashed=false`
  );
  const url = `${DRIVE_API}/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)&pageSize=100&orderBy=modifiedTime desc`;
  const res = await driveFetch(url);
  if (!res.ok) throw new Error(`drive list failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as any;
  return ((json.files || []) as DriveFileMeta[]).sort(
    (a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime)
  );
}

export async function uploadDriveFile(name: string, content: string, existingId?: string): Promise<DriveFileMeta> {
  const boundary = "ccm_boundary_" + Math.random().toString(36).slice(2);
  const metadata: any = { name };
  if (!existingId) metadata.parents = ["appDataFolder"];

  const metaPart = JSON.stringify(metadata);
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metaPart}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const url = existingId
    ? `${DRIVE_UPLOAD}/files/${existingId}?uploadType=multipart`
    : `${DRIVE_UPLOAD}/files?uploadType=multipart`;
  const method = existingId ? "PATCH" : "POST";

  const res = await driveFetch(url, {
    method,
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`drive upload failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as any;
  return { id: json.id, name: json.name, modifiedTime: json.modifiedTime };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

/** `.git/config` for `dir`: a real `.git` directory, or a worktree pointer file (`gitdir: ...`). */
function gitConfigPath(dir: string): string | null {
  const dotgit = path.join(dir, ".git");
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return path.join(dotgit, "config");
    if (st.isFile()) {
      const first = fs.readFileSync(dotgit, "utf-8").split(/\r?\n/)[0] ?? "";
      const m = /^gitdir:\s*(.+?)\s*$/.exec(first);
      if (m) return path.join(path.resolve(dir, m[1]), "config");
    }
  } catch {}
  return null;
}

/** Origin URL of the git repo containing `dir`, or null. Found by walking up to `.git/config`. */
function gitOriginUrl(dir: string): string | null {
  let cur = path.resolve(dir);
  for (let i = 0; i < 32; i++) {
    const cfg = gitConfigPath(cur);
    if (cfg) {
      try {
        const raw = fs.readFileSync(cfg, "utf-8");
        let inOrigin = false;
        for (const line of raw.split(/\r?\n/)) {
          if (/^\s*\[/.test(line)) inOrigin = /^\s*\[\s*remote\s+"origin"\s*\]/.test(line);
          else if (inOrigin) {
            const m = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
            if (m) return m[1];
          }
        }
        return null; // a repo without an origin remote; nothing further up can be this project's repo
      } catch {
        // unreadable config; keep walking up
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/**
 * Drive file name for a store. Each project gets its own remote file so projects never
 * overwrite each other. The name is stable across machines for the same project: an explicit
 * CONTEXT_MCP_SYNC_ID wins, then the git origin URL, then a hash of the folder. (Machines that
 * check out the same project at different paths without git should set CONTEXT_MCP_SYNC_ID.)
 * A pinned store file with a custom name gets its own suffix so two files in one project
 * cannot share a remote; the default filename keeps the plain name (no migration).
 */
export function remoteNameFor(storeFile: string): string {
  const explicit = process.env.CONTEXT_MCP_SYNC_ID?.trim();
  if (explicit) {
    const slug = slugify(explicit);
    return `common-context--${slug || `shared-${sha1hex(explicit).slice(0, 6)}`}.json`;
  }
  const abs = path.resolve(storeFile);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const fileSlug = base === "common-context.json" ? "" : slugify(base.replace(/\.[^.]*$/, "")) || "store";
  const origin = gitOriginUrl(dir);
  if (origin) {
    const cleaned = origin
      .replace(/^(https?:\/\/|ssh:\/\/|git@)/i, "")
      .replace(/^[^@/]+@/, "")
      .replace(/^([^/:]+):\d+(\/|$)/, "$1$2") // ssh://host:port/ → host/ (scp host:path untouched)
      .replace(/\.git$/i, "");
    const slug = slugify(cleaned);
    if (slug) return `common-context--${slug}${fileSlug ? `-${fileSlug}` : ""}.json`;
  }
  const hash = createHash("sha1").update(dir).digest("hex").slice(0, 12);
  const folder = slugify(path.basename(dir)).slice(0, 24);
  return `common-context--${[folder, fileSlug, hash].filter(Boolean).join("-")}.json`;
}

export interface SyncState {
  remote: string | null;
  remoteModifiedTime: string | null;
  localHash: string | null;
  lastPull: string | null;
  lastPush: string | null;
}

const emptySyncState = (): SyncState => ({
  remote: null,
  remoteModifiedTime: null,
  localHash: null,
  lastPull: null,
  lastPush: null,
});

const syncStateFile = (storeFile: string): string => `${path.resolve(storeFile)}.sync.json`;

/**
 * Last-sync bookkeeping, kept next to the store. Advisory only: merge is idempotent, so a
 * lost sidecar just causes one redundant sync. Comparing the Drive-side modifiedTime against
 * this (instead of local mtime) is immune to clock skew between machines.
 */
export function loadSyncState(storeFile: string): SyncState {
  try {
    const raw = JSON.parse(fs.readFileSync(syncStateFile(storeFile), "utf-8")) as Partial<SyncState>;
    if (!raw || typeof raw !== "object") return emptySyncState();
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    return {
      remote: str(raw.remote),
      remoteModifiedTime: str(raw.remoteModifiedTime),
      localHash: str(raw.localHash),
      lastPull: str(raw.lastPull),
      lastPush: str(raw.lastPush),
    };
  } catch {
    return emptySyncState();
  }
}

function saveSyncState(storeFile: string, patch: Partial<SyncState>): SyncState {
  const next = { ...loadSyncState(storeFile), ...patch };
  try {
    fs.writeFileSync(syncStateFile(storeFile), JSON.stringify(next, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {}
  return next;
}

const sha1hex = (s: string): string => createHash("sha1").update(s, "utf-8").digest("hex");

/**
 * Downloads this project's remote file and merges it into the local store under the lock.
 * Merge is a union: remote entries are added, nothing local is deleted, conflicts resolve
 * deterministically (the same result on every machine). Re-pulling a seen remote is a no-op.
 */
export async function pullIfNewer(store: ContextStore): Promise<{ pulled: boolean; reason: string }> {
  if (!isLoggedIn()) return { pulled: false, reason: "not logged in" };
  const file = store.file;
  const remoteName = remoteNameFor(file);
  let remote: DriveFileMeta | null;
  try {
    remote = await findDriveFile(remoteName);
  } catch (e) {
    return { pulled: false, reason: `drive error: ${(e as Error).message}` };
  }
  if (!remote) return { pulled: false, reason: "no remote file" };
  const state = loadSyncState(file);
  if (fs.existsSync(file) && state.remote === remoteName && remote.modifiedTime === state.remoteModifiedTime) {
    return { pulled: false, reason: "remote unchanged" };
  }
  let content: string;
  try {
    content = await downloadDriveFile(remote.id);
  } catch (e) {
    return { pulled: false, reason: `download failed: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Garbage on the remote: keep a local copy, mark it seen, let the next push overwrite it.
    const backup = `${file}.remote-backup-${Date.now()}`;
    try {
      fs.writeFileSync(backup, content, { encoding: "utf-8", mode: 0o600 });
      pruneSiblings(file, "remote-backup", 5);
    } catch {}
    saveSyncState(file, { remote: remoteName, remoteModifiedTime: remote.modifiedTime, lastPull: new Date().toISOString() });
    return { pulled: false, reason: `remote file is not valid JSON (saved to ${backup})` };
  }
  let changed: boolean;
  try {
    changed = store.mergeRemote(parsed);
  } catch (e) {
    // e.g. the remote schema is newer: do NOT mark it seen, so sync keeps refusing to
    // overwrite it instead of downgrading it. The fix is upgrading common-context-mcp.
    return { pulled: false, reason: (e as Error).message };
  }
  saveSyncState(file, { remote: remoteName, remoteModifiedTime: remote.modifiedTime, lastPull: new Date().toISOString() });
  return changed ? { pulled: true, reason: "merged remote changes" } : { pulled: false, reason: "already in sync" };
}

const pendingPush = new Map<string, ContextStore>();
let pushTimer: NodeJS.Timeout | null = null;

export function schedulePush(store: ContextStore): void {
  if (!isLoggedIn()) return;
  pendingPush.set(store.file, store);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const batch = [...pendingPush.values()];
    pendingPush.clear();
    void (async () => {
      for (const s of batch) {
        try {
          await pushNow(s);
        } catch {}
      }
    })();
  }, 500);
}

/**
 * Uploads the local store, but never blindly: when the remote changed since the last sync it
 * is merged first, so a push cannot clobber another machine's entries. Skips when nothing changed.
 */
export async function pushNow(store: ContextStore): Promise<{ pushed: boolean; reason: string }> {
  if (!isLoggedIn()) return { pushed: false, reason: "not logged in" };
  const file = store.file;
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return { pushed: false, reason: "no local file" };
  }
  const remoteName = remoteNameFor(file);
  const state = loadSyncState(file);
  if (state.remote === remoteName && sha1hex(content) === state.localHash) {
    return { pushed: false, reason: "no local changes" };
  }
  let existing: DriveFileMeta | null;
  try {
    existing = await findDriveFile(remoteName);
  } catch (e) {
    return { pushed: false, reason: `drive error: ${(e as Error).message}` };
  }
  let note = "";
  if (existing && existing.modifiedTime !== state.remoteModifiedTime) {
    const pull = await pullIfNewer(store);
    // Proceed only if that remote version is now accounted for (merged, or marked seen as
    // garbage). Anything else — download failed, newer schema — aborts the push.
    const after = loadSyncState(file);
    if (after.remote !== remoteName || existing.modifiedTime !== after.remoteModifiedTime) {
      return { pushed: false, reason: `remote changed; pull first (${pull.reason})` };
    }
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      return { pushed: false, reason: "local file vanished during merge" };
    }
    if (pull.pulled) note = " (merged remote first)";
  }
  try {
    const meta = await uploadDriveFile(remoteName, content, existing?.id);
    saveSyncState(file, {
      remote: remoteName,
      localHash: sha1hex(content),
      remoteModifiedTime: meta.modifiedTime,
      lastPush: new Date().toISOString(),
    });
    return { pushed: true, reason: (existing ? "updated" : "created") + note };
  } catch (e) {
    return { pushed: false, reason: `drive error: ${(e as Error).message}` };
  }
}

export function syncStatus(storeFile?: string): string {
  const cfg = loadOAuthConfig();
  const tokens = loadTokens();
  const lines = [
    `OAuth configured: ${cfg ? "yes" : "no"}`,
    `Logged in: ${tokens ? "yes" : "no"}`,
    `Token file: ${tokenFile()}`,
  ];
  if (tokens) {
    lines.push(`Token expires: ${new Date(tokens.expiry_date).toISOString()}`);
    lines.push(`Has refresh token: ${tokens.refresh_token ? "yes" : "no"}`);
  }
  if (storeFile) {
    const file = path.resolve(storeFile);
    const st = loadSyncState(file);
    lines.push(`Remote file: ${remoteNameFor(file)}`);
    lines.push(`Last pull: ${st.lastPull ?? "never"}`);
    lines.push(`Last push: ${st.lastPush ?? "never"}`);
  }
  return lines.join("\n");
}

export async function flushPendingPush(): Promise<void> {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  const batch = [...pendingPush.values()];
  pendingPush.clear();
  for (const s of batch) {
    try {
      await pushNow(s);
    } catch {}
  }
}
