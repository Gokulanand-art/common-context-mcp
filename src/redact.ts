/** Masks common credential shapes before anything is written to the shared store. */
export function redact(s: string): string {
  return s
    .replace(/(authorization:\s*)(bearer|basic)\s+\S+/gi, "$1$2 [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/g, "Bearer [REDACTED]")
    .replace(/\b(sk|pk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*)("?)[^\s"&,;]+/gi, "$1$2[REDACTED]");
}
