/** Masks common credential shapes before anything is written to the shared store. */
export function redact(s: string): string {
  return s
    .replace(/(authorization:\s*)(bearer|basic)\s+\S+/gi, "$1$2 [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/g, "Bearer [REDACTED]")
    .replace(/\b(sk|pk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/\b(github_pat|glpat)[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._~-]+/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*)("?)[^\s"&,;]+/gi, "$1$2[REDACTED]");
}
