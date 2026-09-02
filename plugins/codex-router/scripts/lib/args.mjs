// Shared argv parser. Keep this file identical in claude-router and
// codex-router (do not merge the git repos). Claude needs empty quoted
// values and optional-value flags; Codex needs stopAtPositional.
// `arrayOptions` is an alias of `repeatableOptions`.

function isOptionLikeToken(token) {
  return Boolean(token) && token !== "-" && String(token).startsWith("-");
}

export function hasLeadingHelpFlag(argv) {
  for (const token of argv) {
    if (token === "--") {
      return false;
    }
    if (!isOptionLikeToken(token)) {
      return false;
    }
    if (token === "--help" || token === "-h") {
      return true;
    }
  }
  return false;
}

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set([
    ...(config.valueOptions ?? []),
    ...(config.arrayOptions ?? [])
  ]);
  const optionalValueOptions = new Set(config.optionalValueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const repeatableOptions = new Set([
    ...(config.repeatableOptions ?? []),
    ...(config.arrayOptions ?? [])
  ]);
  const aliasMap = config.aliasMap ?? {};
  const stopAtPositional = Boolean(config.stopAtPositional);
  const options = {};
  const positionals = [];
  let passthrough = false;

  function assignOption(key, value) {
    if (!repeatableOptions.has(key)) {
      options[key] = value;
      return;
    }
    if (!Array.isArray(options[key])) {
      options[key] = options[key] === undefined ? [] : [options[key]];
    }
    options[key].push(value);
  }

  function hasLaterPositional(startIndex) {
    for (let scan = startIndex; scan < argv.length; scan += 1) {
      const value = argv[scan];
      if (value === "--") {
        return scan + 1 < argv.length;
      }
      if (!String(value).startsWith("-") || value === "-") {
        return true;
      }
    }
    return false;
  }

  function endOptions() {
    if (stopAtPositional) {
      passthrough = true;
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      endOptions();
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equalsIndex = body.indexOf("=");
      const rawKey = equalsIndex === -1 ? body : body.slice(0, equalsIndex);
      const inlineValue = equalsIndex === -1 ? undefined : body.slice(equalsIndex + 1);
      const key = aliasMap[rawKey] ?? rawKey;
      if (optionalValueOptions.has(key)) {
        const nextValue = argv[index + 1];
        if (inlineValue !== undefined) {
          assignOption(key, inlineValue);
        } else if (nextValue !== undefined && !String(nextValue).startsWith("-") && hasLaterPositional(index + 2)) {
          assignOption(key, nextValue);
          index += 1;
        } else {
          assignOption(key, true);
        }
        continue;
      }
      if (booleanOptions.has(key)) {
        assignOption(key, inlineValue === undefined ? true : inlineValue !== "false");
        continue;
      }
      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        assignOption(key, nextValue);
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }
      positionals.push(token);
      endOptions();
      continue;
    }

    const rawKey = token.slice(1);
    const key = aliasMap[rawKey] ?? rawKey;
    if (optionalValueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue !== undefined && !String(nextValue).startsWith("-") && hasLaterPositional(index + 2)) {
        assignOption(key, nextValue);
        index += 1;
      } else {
        assignOption(key, true);
      }
      continue;
    }
    if (booleanOptions.has(key)) {
      assignOption(key, true);
      continue;
    }
    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${rawKey}`);
      }
      assignOption(key, nextValue);
      index += 1;
      continue;
    }
    positionals.push(token);
    endOptions();
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let sawQuotedEmpty = false;

  for (const character of String(raw ?? "")) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
        // Preserve empty quoted values such as --tools "".
        sawQuotedEmpty = current.length === 0;
      } else {
        current += character;
        sawQuotedEmpty = false;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current || sawQuotedEmpty) {
        tokens.push(current);
        current = "";
        sawQuotedEmpty = false;
      }
      continue;
    }
    current += character;
    sawQuotedEmpty = false;
  }

  if (escaping) {
    current += "\\";
  }
  if (current || sawQuotedEmpty) {
    tokens.push(current);
  }
  return tokens;
}
