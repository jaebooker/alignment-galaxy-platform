const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp } = require("node:fs/promises");

const { createFileStorage, sanitizeFileName } = require("../lib/fileStorage");

test("file storage saves readable artifacts with metadata and clears the root", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "alignment-galaxy-files-"));
  const storage = createFileStorage({
    rootDir,
    maxBytes: 1024,
    now: () => "2026-08-08T12:00:00.000Z"
  });

  const file = await storage.save({
    buffer: Buffer.from("artifact contents"),
    contentType: "text/plain",
    originalName: "../eval notes.txt",
    submissionId: "11111111-1111-4111-8111-111111111111",
    uploadedBy: "22222222-2222-4222-8222-222222222222"
  });

  assert.equal(file.original_name, "eval notes.txt");
  assert.equal(file.content_type, "text/plain");
  assert.equal(file.size_bytes, 17);
  assert.equal(file.created_at, "2026-08-08T12:00:00.000Z");
  assert.match(file.storage_key, /^11111111-1111-4111-8111-111111111111\/.+\.txt$/);
  assert.equal((await storage.read(file.storage_key)).toString("utf8"), "artifact contents");

  await storage.clear();
  await assert.rejects(
    () => storage.read(file.storage_key),
    (error) => error.code === "ENOENT"
  );
});

test("file storage rejects oversized uploads and sanitizes names", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "alignment-galaxy-files-"));
  const storage = createFileStorage({ rootDir, maxBytes: 4 });

  assert.equal(sanitizeFileName("../../unsafe:name?.csv"), "unsafe_name_.csv");
  await assert.rejects(
    () => storage.save({
      buffer: Buffer.from("too large"),
      originalName: "large.txt",
      submissionId: "11111111-1111-4111-8111-111111111111",
      uploadedBy: "22222222-2222-4222-8222-222222222222"
    }),
    (error) => error.statusCode === 413
  );
});
