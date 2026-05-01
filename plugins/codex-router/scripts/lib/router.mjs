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

function unsupportedModifier(name, futureMode) {
  throw new Error(`${name} is parsed by codex-router V1 but is not enabled yet. Required future mode: ${futureMode}.`);
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
  if (modifiers.includes("webSearch")) {
    parts.push("", "<web_search>", "Use Codex web search for current external facts, then tie the findings back to this repository.", "</web_search>");
  }
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
  if (modifiers.includes("webSearch")) {
    parts.push("", "<web_search>", "Use Codex web search only where current external facts materially affect the implementation.", "</web_search>");
  }
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
    unsupportedModifier("DocsMCP", "DocsMCP interactive/app-server routing");
  }
  if (options.tool) {
    unsupportedModifier("ToolDirective", "ToolDirective interactive/app-server routing");
  }
  if (options.parallel) {
    unsupportedModifier("Parallel", "Parallel role/lane orchestration");
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
