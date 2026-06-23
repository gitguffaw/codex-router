import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/codex-router/scripts/lib/args.mjs";

test("splitRawArgumentString preserves quoted prompt segments", () => {
  assert.deepEqual(splitRawArgumentString('--model "gpt-5.4 mini" "inspect cache behavior"'), [
    "--model",
    "gpt-5.4 mini",
    "inspect cache behavior"
  ]);
});

test("splitRawArgumentString handles escaped spaces and trailing backslashes", () => {
  assert.deepEqual(splitRawArgumentString("inspect\\ cache behavior\\\\"), ["inspect cache", "behavior\\"]);
});

test("parseArgs supports inline values, aliases, booleans, and passthrough prompts", () => {
  const parsed = parseArgs(["--model=gpt-5.4", "-C", "repo", "--json=false", "--", "--not-a-flag"], {
    valueOptions: ["model", "cwd"],
    booleanOptions: ["json"],
    aliasMap: { C: "cwd" }
  });

  assert.deepEqual(parsed.options, {
    model: "gpt-5.4",
    cwd: "repo",
    json: false
  });
  assert.deepEqual(parsed.positionals, ["--not-a-flag"]);
});

test("parseArgs accumulates repeatable array options", () => {
  const parsed = parseArgs(["--config", 'service_tier="fast"', "-c", 'model="gpt-5.5"', "--enable=multi_agent"], {
    arrayOptions: ["config", "enable"],
    aliasMap: { c: "config" }
  });

  assert.deepEqual(parsed.options, {
    config: ['service_tier="fast"', 'model="gpt-5.5"'],
    enable: ["multi_agent"]
  });
  assert.deepEqual(parsed.positionals, []);
});

test("parseArgs preserves unknown flags as positional prompt text", () => {
  const parsed = parseArgs(["--future-flag", "explain", "-x"], {
    valueOptions: ["model"],
    booleanOptions: ["json"]
  });

  assert.deepEqual(parsed.options, {});
  assert.deepEqual(parsed.positionals, ["--future-flag", "explain", "-x"]);
});

test("parseArgs rejects missing values for configured value options", () => {
  assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value for --model/);
  assert.throws(() => parseArgs(["-m"], { valueOptions: ["model"], aliasMap: { m: "model" } }), /Missing value for -m/);
});
