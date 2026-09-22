const BLOCKING_CODEX_FAILURE =
  /authentication|not authenticated|unauthori[sz]ed|codex login|login required|api key required|not installed|missing required runtime|usage limit exceeded|context window exceeded|cyber policy/i;

export function isLaunchDetail(text) {
  const value = String(text ?? "").trim();
  return (
    /^Starting Codex\b/i.test(value) ||
    /^Resuming thread\b/i.test(value) ||
    /^Thread ready\b/i.test(value) ||
    /^Turn started\b/i.test(value) ||
    /^Queued for background execution\.$/i.test(value)
  );
}

export function isMcpOrConnectionNoise(text) {
  const value = String(text ?? "");
  if (!value.trim()) {
    return false;
  }
  if (/\bmcp server\b/i.test(value) || /mcpServer\/startupStatus/i.test(value) || /\breauthenticationRequired\b/.test(value)) {
    return true;
  }
  if (/\bnot connected\b/i.test(value)) {
    return true;
  }
  return (
    /\bmcp\b/i.test(value) &&
    /\b(?:connect(?:ed|ion|ing)?|startup|unavailable|fail(?:ed|ure)?|error|reauth|oauth|timed out|did(?:n'?t| not) connect)\b/i.test(value)
  );
}

export function isStartupDiagnostic(text) {
  const value = String(text ?? "").trim();
  if (!value) {
    return false;
  }
  return (
    /could not update PATH/i.test(value) ||
    /^WARNING:/i.test(value) ||
    /^config warning\b/i.test(value) ||
    /^deprecat/i.test(value) ||
    /^Startup note:/i.test(value) ||
    /world writable/i.test(value)
  );
}

export function isBlockingCodexFailure(text) {
  const value = String(text ?? "").trim();
  if (!value || isMcpOrConnectionNoise(value)) {
    return false;
  }
  return BLOCKING_CODEX_FAILURE.test(value);
}

export function isHostSuppressedProgressLine(text) {
  const value = String(text ?? "").trim();
  if (!value || isBlockingCodexFailure(value)) {
    return false;
  }
  return isLaunchDetail(value) || isMcpOrConnectionNoise(value) || isStartupDiagnostic(value);
}

export function hostFailureText(text) {
  const value = String(text ?? "").trim();
  if (!value || isHostSuppressedProgressLine(value)) {
    return "";
  }
  return value;
}

export function hostStderrLine(event) {
  const explicit = typeof event?.hostMessage === "string" ? event.hostMessage.trim() : "";
  if (!explicit) {
    return "";
  }
  if (explicit === "Codex is ready.") {
    return explicit;
  }
  return hostFailureText(explicit);
}

export function cleanCodexStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => isBlockingCodexFailure(line))
    .join("\n");
}
