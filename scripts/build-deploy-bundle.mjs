#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const bundleName = "autoboard-server-deploy";
const bundleRoot = path.join(distRoot, bundleName);

const sources = [
  ["deploy", "deploy"],
  ["scripts/task-journal.mjs", "scripts/task-journal.mjs"],
  ["scripts/clear-feishu-test-data.mjs", "scripts/clear-feishu-test-data.mjs"],
  ["scripts/migrate-minister-board.mjs", "scripts/migrate-minister-board.mjs"],
  ["scripts/manage-board-owners.mjs", "scripts/manage-board-owners.mjs"],
  ["scripts/financial-control.mjs", "scripts/financial-control.mjs"],
  ["scripts/send-quick-links-smoke.mjs", "scripts/send-quick-links-smoke.mjs"],
  ["lib/financial-rules.mjs", "lib/financial-rules.mjs"],
  ["openclaw-plugins/board-quick-links", "openclaw-plugins/board-quick-links"],
  ["workspace", "workspace"],
];

await fs.rm(bundleRoot, { recursive: true, force: true });
await fs.mkdir(bundleRoot, { recursive: true });

for (const [source, target] of sources) {
  await fs.cp(
    path.join(projectRoot, source),
    path.join(bundleRoot, target),
    { recursive: true },
  );
}

for (const relative of [
  "deploy/install.sh",
  "deploy/export-migration-state.sh",
  "deploy/import-migration-state.sh",
  "deploy/configure-runtime.sh",
  "deploy/healthcheck.sh",
  "deploy/backup.sh",
  "deploy/patch-feishu-events.mjs",
  "deploy/migrate-config.mjs",
  "scripts/task-journal.mjs",
  "scripts/clear-feishu-test-data.mjs",
  "scripts/migrate-minister-board.mjs",
  "scripts/manage-board-owners.mjs",
  "scripts/financial-control.mjs",
  "scripts/send-quick-links-smoke.mjs",
]) {
  await fs.chmod(path.join(bundleRoot, relative), 0o755);
}

if (process.platform === "darwin") {
  await execFileAsync("xattr", ["-cr", bundleRoot]);
}

const filePaths = [];
async function collectFiles(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolute);
    } else if (entry.isFile()) {
      filePaths.push(absolute);
    }
  }
}
await collectFiles(bundleRoot);
filePaths.sort();

const manifest = [];
for (const absolute of filePaths) {
  const buffer = await fs.readFile(absolute);
  manifest.push({
    path: path.relative(bundleRoot, absolute),
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  });
}
await fs.writeFile(
  path.join(bundleRoot, "MANIFEST.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      openclawVersion: "2026.7.1-2",
      feishuPluginVersion: "2026.7.1",
      files: manifest,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const archive = path.join(distRoot, `${bundleName}.tar.gz`);
await fs.rm(archive, { force: true });
await execFileAsync("tar", [
  "--no-xattrs",
  "-czf",
  archive,
  "-C",
  distRoot,
  bundleName,
], {
  env: {
    ...process.env,
    COPYFILE_DISABLE: "1",
  },
});

console.log(
  JSON.stringify(
    {
      bundleRoot,
      archive,
      files: manifest.length + 1,
    },
    null,
    2,
  ),
);
