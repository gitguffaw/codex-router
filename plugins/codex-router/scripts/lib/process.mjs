import { spawnSync } from "node:child_process";
import process from "node:process";

function getWindowsProcessStartTime(pid, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  try {
    // Win32_Process.CreationDate is a stable per-process timestamp; two distinct
    // processes that reused a pid have different creation dates. Get-CimInstance
    // materializes it as a .NET DateTime, and round-trip ("o") formatting gives
    // a deterministic string to compare recorded-vs-current identity. wmic is
    // deprecated/removed on recent Windows, so use PowerShell CIM.
    const result = spawnSyncImpl(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToString("o") }`
      ],
      { encoding: "utf8", windowsHide: true, timeout: 4000 }
    );
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

export function getProcessStartTime(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return getWindowsProcessStartTime(pid, options);
  }
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  try {
    const result = spawnSyncImpl("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid, options = {}) {
  if (!Number.isFinite(pid)) return false;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (probeError) {
    // EPERM means the process exists but is owned by another user.
    return probeError?.code === "EPERM";
  }
}

export function jobProcessIdentityMatches(pid, expectedStartTime, options = {}) {
  if (!isProcessAlive(pid, options)) return false;
  if (!expectedStartTime) return false;
  const getProcessStartTimeImpl = options.getProcessStartTimeImpl ?? getProcessStartTime;
  const currentStartTime = getProcessStartTimeImpl(pid);
  if (!currentStartTime) return false;
  return currentStartTime === expectedStartTime;
}


export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export async function terminateWithEscalation(pid, options = {}) {
  const graceMs = options.graceMs ?? 5000;
  const result = terminateProcessTree(pid, options);
  if (!result.delivered) {
    return result;
  }

  await new Promise((resolve) => setTimeout(resolve, graceMs));

  const killImpl = options.killImpl ?? process.kill.bind(process);
  const platform = options.platform ?? process.platform;
  const expectedStartTime = options.processStartTime ?? options.expectedStartTime ?? null;
  const getProcessStartTimeImpl = options.getProcessStartTimeImpl ?? getProcessStartTime;

  if (platform === "win32") {
    try {
      killImpl(pid, 0);
      return { ...result, escalated: true };
    } catch (probeError) {
      return probeError?.code === "EPERM" ? { ...result, escalated: true } : result;
    }
  }

  const currentStartTime = expectedStartTime ? getProcessStartTimeImpl(pid) : null;
  if (!expectedStartTime || !currentStartTime || currentStartTime !== expectedStartTime) {
    return { ...result, escalationSkipped: "unverified-process-identity" };
  }

  // Only escalate targets whose leader still matches the recorded worker
  // identity. A recycled numeric PID/PGID cannot prove ownership.
  let survivors = false;
  if (result.method === "process-group") {
    try {
      killImpl(-pid, 0);
      survivors = true;
    } catch (probeError) {
      survivors = probeError?.code === "EPERM";
    }
  }
  if (!survivors && result.method === "process") {
    try {
      killImpl(pid, 0);
      survivors = true;
    } catch (probeError) {
      survivors = probeError?.code === "EPERM";
    }
  }
  if (!survivors) {
    return result;
  }

  try {
    if (result.method === "process-group") {
      killImpl(-pid, "SIGKILL");
    } else {
      killImpl(pid, "SIGKILL");
    }
  } catch {
    // Process may have exited between the liveness check and SIGKILL.
  }
  return { ...result, escalated: true };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
