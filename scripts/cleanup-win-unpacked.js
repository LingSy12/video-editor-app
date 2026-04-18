const fs = require("fs/promises");
const path = require("path");

async function removeIfPresent(targetPath) {
  if (!targetPath) return false;

  try {
    await fs.rm(targetPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function cleanup(buildResult) {
  const outDir = buildResult && typeof buildResult.outDir === "string" ? buildResult.outDir : null;
  if (!outDir) return [];

  const removed = [];
  const directWinUnpacked = path.join(outDir, "win-unpacked");
  if (await removeIfPresent(directWinUnpacked)) removed.push(directWinUnpacked);

  const parentDir = path.dirname(outDir);
  if (parentDir && parentDir !== outDir) {
    const legacyWinUnpacked = path.join(parentDir, "win-unpacked");
    if (legacyWinUnpacked !== directWinUnpacked && await removeIfPresent(legacyWinUnpacked)) {
      removed.push(legacyWinUnpacked);
    }
  }

  return [];
}

exports.default = cleanup;
