const path = require("node:path");
const { mkdir, readFile, stat, writeFile } = require("node:fs/promises");

function createJsonStore({ dataFile, seedFile, normalizeState, now }) {
  async function ensureDataFile() {
    await mkdir(path.dirname(dataFile), { recursive: true });
    try {
      await stat(dataFile);
    } catch {
      const seed = await readFile(seedFile, "utf8");
      await writeFile(dataFile, seed, "utf8");
    }
  }

  async function read() {
    await ensureDataFile();
    const state = JSON.parse(await readFile(dataFile, "utf8"));
    return normalizeState(state);
  }

  async function write(state) {
    state.updated_at = now();
    await writeFile(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function reset() {
    const seed = JSON.parse(await readFile(seedFile, "utf8"));
    const state = normalizeState(seed);
    await write(state);
    return state;
  }

  async function transaction(mutator) {
    const state = await read();
    const result = await mutator(state);
    await write(state);
    return result ?? state;
  }

  return {
    dataFile,
    read,
    reset,
    transaction,
    write
  };
}

module.exports = {
  createJsonStore
};
