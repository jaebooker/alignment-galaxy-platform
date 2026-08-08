const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { loadEnv, parseLine, parseValue } = require("../lib/env");

test("env parser handles comments, exports, and quoted values", () => {
  assert.deepEqual(parseLine("DATABASE_URL=postgres://localhost/db"), ["DATABASE_URL", "postgres://localhost/db"]);
  assert.deepEqual(parseLine("export STRIPE_CURRENCY=usd # local"), ["STRIPE_CURRENCY", "usd"]);
  assert.equal(parseValue("\"line\\nnext\""), "line\nnext");
  assert.equal(parseValue("'sk_test_value'"), "sk_test_value");
  assert.equal(parseLine("# ignored"), null);
});

test("loadEnv populates missing env values without overriding shell env", () => {
  const dir = mkdtempSync(join(tmpdir(), "alignment-galaxy-env-"));
  const file = join(dir, ".env");
  const preservedKey = "ALIGNMENT_GALAXY_ENV_TEST_KEEP";
  const loadedKey = "ALIGNMENT_GALAXY_ENV_TEST_LOAD";
  process.env[preservedKey] = "from-shell";
  delete process.env[loadedKey];

  writeFileSync(file, `${preservedKey}=from-file\n${loadedKey}=loaded\n`);
  const loaded = loadEnv(file);

  assert.equal(loaded[preservedKey], "from-file");
  assert.equal(process.env[preservedKey], "from-shell");
  assert.equal(process.env[loadedKey], "loaded");

  delete process.env[preservedKey];
  delete process.env[loadedKey];
});
