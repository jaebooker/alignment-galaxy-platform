const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { mkdir, readFile, rm, stat, writeFile } = require("node:fs/promises");

const ROOT = path.join(__dirname, "..");
const DEFAULT_UPLOAD_DIR = path.join(ROOT, "storage", "artifacts");
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function createFileStorage({
  rootDir = process.env.ALIGNMENT_GALAXY_UPLOAD_DIR || DEFAULT_UPLOAD_DIR,
  maxBytes = Number(process.env.ALIGNMENT_GALAXY_MAX_UPLOAD_BYTES || DEFAULT_MAX_BYTES),
  now = () => new Date().toISOString()
} = {}) {
  const resolvedRoot = path.resolve(rootDir);

  async function save({ buffer, contentType, originalName, submissionId, uploadedBy }) {
    if (!Buffer.isBuffer(buffer)) {
      throw storageError(400, "Uploaded file must be a buffer.");
    }
    if (buffer.length === 0) {
      throw storageError(400, "Uploaded file is empty.");
    }
    if (buffer.length > maxBytes) {
      throw storageError(413, `Uploaded file exceeds the ${formatBytes(maxBytes)} limit.`);
    }

    const id = randomUUID();
    const safeName = sanitizeFileName(originalName || "artifact");
    const extension = path.extname(safeName).slice(0, 16);
    const storageKey = `${submissionId}/${id}${extension}`;
    const destination = safePath(resolvedRoot, storageKey);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, buffer, { flag: "wx" });

    return {
      id,
      submission_id: submissionId,
      uploaded_by: uploadedBy,
      storage_key: storageKey,
      original_name: safeName,
      content_type: contentType || "application/octet-stream",
      size_bytes: buffer.length,
      checksum_sha256: createHash("sha256").update(buffer).digest("hex"),
      created_at: now()
    };
  }

  async function read(storageKey) {
    return readFile(safePath(resolvedRoot, storageKey));
  }

  async function info(storageKey) {
    return stat(safePath(resolvedRoot, storageKey));
  }

  async function clear() {
    await rm(resolvedRoot, { recursive: true, force: true });
    await mkdir(resolvedRoot, { recursive: true });
  }

  return {
    clear,
    info,
    maxBytes,
    read,
    rootDir: resolvedRoot,
    save
  };
}

function safePath(rootDir, storageKey) {
  const resolved = path.resolve(rootDir, storageKey);
  if (!resolved.startsWith(`${rootDir}${path.sep}`)) {
    throw storageError(400, "Invalid storage key.");
  }
  return resolved;
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName)).replace(/[^\w.\- ]+/g, "_").trim();
  return baseName.slice(0, 180) || "artifact";
}

function storageError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

module.exports = {
  DEFAULT_UPLOAD_DIR,
  createFileStorage,
  sanitizeFileName
};
