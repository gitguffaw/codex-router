import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree, terminateWithEscalation } from "../plugins/codex-router/scripts/lib/process.mjs";

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
