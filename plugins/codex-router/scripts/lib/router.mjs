const MODE_CONFIG = {
  analyze: {
    title: "Codex Analyze",
    workflow: "Analyze",
    sandbox: "read-only",
    write: false
  },
  exec: {
    title: "Codex Exec",
    workflow: "Exec",
    sandbox: "workspace-write",
    write: true
  }
};

function requirePrompt(prompt) {
  if (!String(prompt ?? "").trim()) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

function modifierValue(modifiers, prefix) {
  const modifier = modifiers.find((entry) => entry.startsWith(prefix));
  return modifier ? modifier.slice(prefix.length).trim() : "";
}

function appendModifierInstructions(parts, modifiers, mode) {
  if (modifiers.includes("webSearch")) {
    parts.push(
      "",
      "<web_search>",
      mode === "exec"
        ? "Use Codex web search only where current external facts materially affect the implementation."
        : "Use Codex web search for current external facts, then tie the findings back to this repository.",
      "</web_search>"
    );
  }

  if (modifiers.includes("docsMcp")) {
    parts.push(
      "",
      "<docs_mcp>",
      "Use inner Codex docs tooling for docs/spec retrieval when available. Prefer openaiDeveloperDocs for OpenAI/Codex topics, official OpenAI docs via web search when needed, and configured docs MCPs such as context7 for third-party libraries.",
      "State which docs source you used and tie the result back to this repository.",
      "</docs_mcp>"
    );
  }

  const toolDirective = modifierValue(modifiers, "tool:");
  if (toolDirective) {
    parts.push(
      "",
      "<tool_directive>",
      `Use the requested inner Codex capability: ${toolDirective}.`,
      "First verify the capability is available in the Codex session. If it is unavailable, say that explicitly instead of substituting Claude's outer tools.",
      "</tool_directive>"
    );
  }

  if (modifiers.includes("parallel")) {
    parts.push(
      "",
      "<parallel_work>",
      mode === "exec"
        ? "Use Codex subagents or multiple internal lanes when they materially improve the result. Keep write ownership coordinated, avoid conflicting edits, and merge into one final implementation summary."
        : "Use Codex subagents or multiple internal lanes when they materially improve coverage. Split the work, reconcile disagreements, and return one consolidated answer.",
      "</parallel_work>"
    );
  }
}

function buildAnalyzePrompt(prompt, modifiers) {
  const parts = [
    "<task>",
    prompt,
    "</task>",
    "",
    "<structured_output_contract>",
    "Return observed facts, inferences, tradeoffs, recommendation, and next action. Keep claims grounded in repository context or tool output.",
    "</structured_output_contract>"
  ];
  appendModifierInstructions(parts, modifiers, "analyze");
  return parts.join("\n");
}

function buildExecPrompt(prompt, modifiers) {
  const parts = [
    "<task>",
    prompt,
    "</task>",
    "",
    "<completion_contract>",
    "Implement the requested change narrowly. Return summary, touched files, verification performed, and residual risks.",
    "</completion_contract>",
    "",
    "<action_safety>",
    "Keep changes tightly scoped. Avoid unrelated refactors. Preserve user changes.",
    "</action_safety>"
  ];
  appendModifierInstructions(parts, modifiers, "exec");
  return parts.join("\n");
}

export function buildRouterRequest({ mode, prompt, options = {}, modelControls = {} }) {
  const config = MODE_CONFIG[mode];
  if (!config) {
    throw new Error(`Unsupported router mode "${mode}".`);
  }

  const modifiers = [];
  if (options.search) {
    modifiers.push("webSearch");
  }
  if (options.docs) {
    modifiers.push("docsMcp");
  }
  if (options.tool) {
    const toolDirective = String(options.tool).trim();
    if (toolDirective) {
      modifiers.push(`tool:${toolDirective}`);
    }
  }
  if (options.parallel) {
    modifiers.push("parallel");
  }

  requirePrompt(prompt);
  const routedPrompt = mode === "analyze" ? buildAnalyzePrompt(prompt, modifiers) : buildExecPrompt(prompt, modifiers);
  return {
    mode,
    launchSurface: "appServerTurn",
    sandbox: config.sandbox,
    write: config.write,
    title: config.title,
    workflow: config.workflow,
    modifiers,
    prompt: routedPrompt,
    userRequest: prompt,
    model: modelControls.model ?? null,
    effort: modelControls.effort ?? null,
    serviceTier: modelControls.serviceTier ?? null,
    configOverrides: modelControls.configOverrides ?? {}
  };
}
