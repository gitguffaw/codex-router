import test from "node:test";
import assert from "node:assert/strict";

import {
  isProcessAlive,
  jobProcessIdentityMatches,
  shouldTerminateTrackedProcess,
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

test("shouldTerminateTrackedProcess requires proven identity on POSIX", () => {
  const base = {
    killImpl() {},
    getProcessStartTimeImpl() {
      return "live-start";
    }
  };
  // Match → terminate.
  assert.equal(
    shouldTerminateTrackedProcess(1234, "live-start", { platform: "linux", ...base }),
    true
  );
  // Mismatch (recycled pid) → skip.
  assert.equal(
    shouldTerminateTrackedProcess(1234, "recorded-start", { platform: "linux", ...base }),
    false
  );
  // No recorded start time → skip.
  assert.equal(
    shouldTerminateTrackedProcess(1234, null, { platform: "linux", ...base }),
    false
  );
});

test("shouldTerminateTrackedProcess falls back to liveness-only on Windows (no worker leak)", () => {
  // Windows has no start-time identity, so a live worker must still be
  // terminated even though processStartTime is null.
  assert.equal(
    shouldTerminateTrackedProcess(1234, null, {
      platform: "win32",
      killImpl() {},
      getProcessStartTimeImpl() {
        throw new Error("must not consult start time on Windows");
      }
    }),
    true
  );
  // A dead pid is still skipped on Windows.
  assert.equal(
    shouldTerminateTrackedProcess(1234, null, {
      platform: "win32",
      killImpl() {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
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
