import test from "node:test";
import assert from "node:assert/strict";

import {
  getProcessStartTime,
  isProcessAlive,
  jobProcessIdentityMatches,
  terminateProcessTree,
  terminateWithEscalation
} from "../plugins/codex-router/scripts/lib/process.mjs";

test("jobProcessIdentityMatches rejects a non-finite pid without probing", () => {
  const matches = jobProcessIdentityMatches(Number.NaN, "expected-start", {
    killImpl() {
      throw new Error("non-finite pids must not be probed");
    },
    getProcessStartTimeImpl() {
      throw new Error("non-finite pids must not have their start time read");
    }
  });

  assert.equal(matches, false);
});

test("jobProcessIdentityMatches rejects a dead pid", () => {
  const matches = jobProcessIdentityMatches(1234, "expected-start", {
    killImpl(pid, signal) {
      assert.equal(pid, 1234);
      assert.equal(signal, 0);
      const error = new Error("dead");
      error.code = "ESRCH";
      throw error;
    },
    getProcessStartTimeImpl() {
      throw new Error("dead pids must not have their start time read");
    }
  });

  assert.equal(matches, false);
});

test("jobProcessIdentityMatches rejects a missing expected start time", () => {
  const matches = jobProcessIdentityMatches(1234, null, {
    killImpl(pid, signal) {
      assert.equal(pid, 1234);
      assert.equal(signal, 0);
    },
    getProcessStartTimeImpl() {
      throw new Error("missing expected identity must short-circuit the start-time read");
    }
  });

  assert.equal(matches, false);
});

test("jobProcessIdentityMatches rejects an unknown current start time", () => {
  const matches = jobProcessIdentityMatches(1234, "expected-start", {
    killImpl() {},
    getProcessStartTimeImpl(pid) {
      assert.equal(pid, 1234);
      return null;
    }
  });

  assert.equal(matches, false);
});

test("jobProcessIdentityMatches rejects a mismatched start time", () => {
  const matches = jobProcessIdentityMatches(1234, "expected-start", {
    killImpl() {},
    getProcessStartTimeImpl(pid) {
      assert.equal(pid, 1234);
      return "different-start";
    }
  });

  assert.equal(matches, false);
});

test("jobProcessIdentityMatches accepts a live pid with a matching start time", () => {
  const matches = jobProcessIdentityMatches(1234, "expected-start", {
    killImpl(pid, signal) {
      assert.equal(pid, 1234);
      assert.equal(signal, 0);
    },
    getProcessStartTimeImpl(pid) {
      assert.equal(pid, 1234);
      return "expected-start";
    }
  });

  assert.equal(matches, true);
});

test("isProcessAlive reports a live pid, a dead pid, an EPERM pid, and a non-finite pid", () => {
  assert.equal(isProcessAlive(1234, { killImpl() {} }), true);
  assert.equal(
    isProcessAlive(1234, {
      killImpl() {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
    }),
    false
  );
  assert.equal(
    isProcessAlive(1234, {
      killImpl() {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
    }),
    true
  );
  assert.equal(isProcessAlive(Number.NaN, { killImpl() {} }), false);
});

test("getProcessStartTime reads Win32_Process.CreationDate via PowerShell on Windows", () => {
  let captured = null;
  const startTime = getProcessStartTime(4321, {
    platform: "win32",
    spawnSyncImpl(command, args) {
      captured = { command, args };
      return { status: 0, stdout: "2026-07-11T12:00:00.0000000-07:00\n", stderr: "" };
    }
  });

  assert.equal(startTime, "2026-07-11T12:00:00.0000000-07:00");
  assert.equal(captured.command, "powershell.exe");
  assert.match(captured.args.join(" "), /Win32_Process -Filter "ProcessId=4321"/);
});

test("getProcessStartTime returns null on Windows when PowerShell fails or is empty", () => {
  assert.equal(
    getProcessStartTime(4321, { platform: "win32", spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "boom" }) }),
    null
  );
  assert.equal(
    getProcessStartTime(4321, { platform: "win32", spawnSyncImpl: () => ({ status: 0, stdout: "   \n", stderr: "" }) }),
    null
  );
});

test("getProcessStartTime reads lstart via ps on POSIX", () => {
  let captured = null;
  const startTime = getProcessStartTime(4321, {
    platform: "linux",
    spawnSyncImpl(command, args) {
      captured = { command, args };
      return { status: 0, stdout: "Sat Jul 11 12:00:00 2026\n", stderr: "" };
    }
  });

  assert.equal(startTime, "Sat Jul 11 12:00:00 2026");
  assert.equal(captured.command, "ps");
  assert.deepEqual(captured.args, ["-p", "4321", "-o", "lstart="]);
});

test("jobProcessIdentityMatches works uniformly once Windows exposes a start time", () => {
  // With a real Windows CreationDate, teardown can prove identity: a recycled
  // pid (mismatched creation date) is skipped, a matching one is terminated —
  // no platform-specific liveness-only fallback, so no unrelated-pid kill.
  const winStart = "2026-07-11T12:00:00.0000000-07:00";
  assert.equal(
    jobProcessIdentityMatches(4321, winStart, {
      killImpl() {},
      getProcessStartTimeImpl: () => winStart
    }),
    true
  );
  assert.equal(
    jobProcessIdentityMatches(4321, winStart, {
      killImpl() {},
      getProcessStartTimeImpl: () => "2000-01-01T00:00:00.0000000-07:00"
    }),
    false
  );
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateWithEscalation SIGKILLs a surviving group when the leader identity still matches", async () => {
  const signals = [];
  const outcome = await terminateWithEscalation(1234, {
    platform: "linux",
    graceMs: 0,
    processStartTime: "same-process",
    getProcessStartTimeImpl(pid) {
      assert.equal(pid, 1234);
      return "same-process";
    },
    killImpl(target, signal) {
      signals.push([target, signal]);
      // Group probe (-1234, 0), group SIGTERM, and group SIGKILL all succeed.
    }
  });

  assert.equal(outcome.escalated, true);
  assert.deepEqual(signals.at(-1), [-1234, "SIGKILL"]);
});

test("terminateWithEscalation does not escalate when the whole group is gone", async () => {
  const signals = [];
  const outcome = await terminateWithEscalation(1234, {
    platform: "linux",
    graceMs: 0,
    processStartTime: "same-process",
    getProcessStartTimeImpl() {
      return "same-process";
    },
    killImpl(target, signal) {
      signals.push([target, signal]);
      if (signal === 0) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    }
  });

  assert.equal(outcome.escalated, undefined);
  assert.equal(signals.some(([, signal]) => signal === "SIGKILL"), false);
});

test("terminateWithEscalation skips SIGKILL when the stored leader identity no longer matches", async () => {
  const signals = [];
  const outcome = await terminateWithEscalation(1234, {
    platform: "linux",
    graceMs: 0,
    processStartTime: "original-process",
    getProcessStartTimeImpl(pid) {
      assert.equal(pid, 1234);
      return "reused-process";
    },
    killImpl(target, signal) {
      signals.push([target, signal]);
    }
  });

  assert.equal(outcome.escalated, undefined);
  assert.equal(outcome.escalationSkipped, "unverified-process-identity");
  assert.deepEqual(signals, [[-1234, "SIGTERM"]]);
});

test("terminateWithEscalation skips SIGKILL when the leader exited before escalation", async () => {
  const signals = [];
  const outcome = await terminateWithEscalation(1234, {
    platform: "linux",
    graceMs: 0,
    processStartTime: "original-process",
    getProcessStartTimeImpl(pid) {
      assert.equal(pid, 1234);
      return null;
    },
    killImpl(target, signal) {
      signals.push([target, signal]);
    }
  });

  assert.equal(outcome.escalated, undefined);
  assert.equal(outcome.escalationSkipped, "unverified-process-identity");
  assert.deepEqual(signals, [[-1234, "SIGTERM"]]);
});
