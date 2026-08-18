import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureStateDir, resolveStateDir } from "./state.mjs";

const POLICY_ROOT = path.resolve(fileURLToPath(new URL("../../policy/Codex", import.meta.url)));
const POLICY_FILES = [
  "SKILL.md",
  "Workflows/Analyze.md",
  "Workflows/Exec.md",
  "Workflows/Review.md",
  "Workflows/Parallel.md",
  "Workflows/AnalyzeWeb.md",
  "Workflows/AnalyzeDocs.md",
  "Workflows/ToolDirected.md",
  "references/LaunchPatterns.md",
  "references/QuickRef.md"
];

function readPolicyFiles() {
  return POLICY_FILES.map((relativePath) => {
    const file = path.join(POLICY_ROOT, relativePath);
    return {
      path: relativePath,
      content: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    };
  });
}

function hashPolicy(policyFiles) {
  const hash = createHash("sha256");
  for (const file of policyFiles) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function contextPackId(data) {
  return `ctx-${createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16)}`;
}

export function createContextPack(workspaceRoot, request) {
  const policyFiles = readPolicyFiles();
  const policyHash = hashPolicy(policyFiles);
  const data = {
    version: 1,
    createdAt: new Date().toISOString(),
    policyHash,
    mode: request.mode,
    modifiers: request.modifiers ?? [],
    workflow: request.workflow ?? null,
    userRequest: request.userRequest ?? "",
    prompt: request.prompt ?? "",
    nonGoals: request.nonGoals ?? [],
    decision: request.decision ?? {},
    constraints: request.constraints ?? [],
    policyFiles: policyFiles.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex")
    }))
  };
  const id = contextPackId(data);
  ensureStateDir(workspaceRoot);
  const dir = path.join(resolveStateDir(workspaceRoot), "context-packs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ id, ...data }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { id, file, policyHash };
}
