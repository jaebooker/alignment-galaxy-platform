const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

function loadEnv(filePath = path.join(__dirname, "..", ".env"), { override = false } = {}) {
  if (!existsSync(filePath)) return {};

  const loaded = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) continue;

    const [key, value] = entry;
    loaded[key] = value;
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return loaded;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const body = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
  const separator = body.indexOf("=");
  if (separator === -1) return null;

  const key = body.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  return [key, parseValue(body.slice(separator + 1).trim())];
}

function parseValue(value) {
  if (!value) return "";

  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    if (quote === "'") return inner;
    return inner
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll("\\t", "\t")
      .replaceAll("\\\"", "\"")
      .replaceAll("\\\\", "\\");
  }

  return value.replace(/\s+#.*$/, "").trim();
}

module.exports = {
  loadEnv,
  parseLine,
  parseValue
};
