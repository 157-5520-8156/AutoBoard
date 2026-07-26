#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OPENCLAW_HOME =
  process.env.OPENCLAW_STATE_DIR ??
  path.join(process.env.OPENCLAW_HOME ?? os.homedir(), ".openclaw");
const CHECK_ONLY = process.argv.includes("--check");
const PATCH_MARKER = "AUTOBOARD_FEISHU_EVENT_PATCH_V2";
const PREVIOUS_PATCH_MARKER = "AUTOBOARD_FEISHU_EVENT_PATCH_V1";

async function findMonitorFile() {
  const projectsRoot = path.join(OPENCLAW_HOME, "npm", "projects");
  const projects = await fs.readdir(projectsRoot, { withFileTypes: true });
  const candidates = [];
  for (const project of projects) {
    if (!project.isDirectory() || !project.name.startsWith("openclaw-feishu-")) {
      continue;
    }
    const projectRoot = path.join(projectsRoot, project.name);
    const retainedRecords = await fs
      .readdir(path.join(projectRoot, ".openclaw-retained-npm-installs"))
      .catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
    if (retainedRecords.some((file) => file.endsWith(".json"))) {
      continue;
    }
    const packageRoot = path.join(
      projectRoot,
      "node_modules",
      "@openclaw",
      "feishu",
    );
    const packageJson = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (packageJson.version !== "2026.7.1") {
      throw new Error(
        `Feishu 插件版本为 ${packageJson.version}，补丁只验证过 2026.7.1`,
      );
    }
    const distRoot = path.join(packageRoot, "dist");
    const files = await fs.readdir(distRoot);
    for (const file of files) {
      if (!/^monitor\.account-.*\.js$/.test(file)) continue;
      const candidate = path.join(distRoot, file);
      const source = await fs.readFile(candidate, "utf8");
      if (source.includes("function registerEventHandlers(eventDispatcher, context)")) {
        candidates.push({ candidate, source });
      }
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`预期找到 1 个 Feishu monitor 文件，实际找到 ${candidates.length} 个`);
  }
  return candidates[0];
}

function patchedSource(original) {
  let source = original;
  const functionMarker =
    "function registerEventHandlers(eventDispatcher, context) {";
  const v2Marker = `const ${PATCH_MARKER} = true;`;
  const legacyStart = source.indexOf("const AUTOBOARD_BASE_TOKEN =");
  const v2Start = source.indexOf(v2Marker);
  if (
    v2Start >= 0 &&
    legacyStart >= 0 &&
    legacyStart < v2Start &&
    source.slice(legacyStart, v2Start).includes(
      "function enqueueAutoBoardBitableEvent",
    )
  ) {
    source = `${source.slice(0, legacyStart)}${source.slice(v2Start)}`;
  }
  if (source.includes(PATCH_MARKER)) return source;

  if (!source.includes('import { execFile } from "node:child_process";')) {
    const importMarker = 'import path from "node:path";';
    if (!source.includes(importMarker)) {
      throw new Error("无法找到 node:path 导入位置");
    }
    source = source.replace(
      importMarker,
      `${importMarker}\nimport { execFile } from "node:child_process";`,
    );
  }

  const bridge = `const ${PATCH_MARKER} = true;
const AUTOBOARD_BASE_TOKEN = process.env.AUTOBOARD_BASE_TOKEN ?? "";
const AUTOBOARD_TASK_TABLE_ID = process.env.AUTOBOARD_TASK_TABLE_ID ?? "";
const AUTOBOARD_JOURNAL_SCRIPT = process.env.AUTOBOARD_JOURNAL_SCRIPT ?? "";
const AUTOBOARD_EVENT_DIR =
  process.env.AUTOBOARD_STATE_DIR
    ? path.join(process.env.AUTOBOARD_STATE_DIR, "bitable-events")
    : path.join(os.homedir(), ".openclaw", "workspace", "state", "bitable-events");
const AUTOBOARD_FINANCE_BASE_TOKEN =
\tprocess.env.AUTOBOARD_FINANCE_BASE_TOKEN ?? "";
const AUTOBOARD_FINANCE_SCRIPT =
\tprocess.env.AUTOBOARD_FINANCE_SCRIPT ?? "";
const AUTOBOARD_FINANCE_EVENT_DIR =
\tprocess.env.AUTOBOARD_STATE_DIR
\t\t? path.join(process.env.AUTOBOARD_STATE_DIR, "financial-events")
\t\t: path.join(os.homedir(), ".openclaw", "workspace", "state", "financial-events");
const AUTOBOARD_FINANCE_SOURCE_TABLE_IDS = new Set(
\tString(process.env.AUTOBOARD_FINANCE_SOURCE_TABLE_IDS ?? "")
\t\t.split(",")
\t\t.map((value) => value.trim())
\t\t.filter(Boolean)
);
let autoBoardEventQueue = Promise.resolve();
function enqueueAutoBoardBitableEvent(data, log) {
\tlet script;
\tlet eventDir;
\tlet label;
\tif (
\t\tAUTOBOARD_BASE_TOKEN &&
\t\tAUTOBOARD_TASK_TABLE_ID &&
\t\tAUTOBOARD_JOURNAL_SCRIPT &&
\t\tdata?.file_token === AUTOBOARD_BASE_TOKEN &&
\t\tdata?.table_id === AUTOBOARD_TASK_TABLE_ID
\t) {
\t\tscript = AUTOBOARD_JOURNAL_SCRIPT;
\t\teventDir = AUTOBOARD_EVENT_DIR;
\t\tlabel = "task-journal";
\t} else if (
\t\tAUTOBOARD_FINANCE_BASE_TOKEN &&
\t\tAUTOBOARD_FINANCE_SCRIPT &&
\t\tdata?.file_token === AUTOBOARD_FINANCE_BASE_TOKEN &&
\t\tAUTOBOARD_FINANCE_SOURCE_TABLE_IDS.has(data?.table_id)
\t) {
\t\tscript = AUTOBOARD_FINANCE_SCRIPT;
\t\teventDir = AUTOBOARD_FINANCE_EVENT_DIR;
\t\tlabel = "financial-control";
\t} else {
\t\treturn Promise.resolve();
\t}
\tconst task = () => new Promise((resolve, reject) => {
\t\tfs.mkdirSync(eventDir, { recursive: true, mode: 448 });
\t\tconst eventKey = String(
\t\t\tdata.event_id ??
\t\t\tdata.uuid ??
\t\t\tcreateHash("sha256").update(JSON.stringify(data)).digest("hex")
\t\t).replace(/[^a-zA-Z0-9_-]/g, "_");
\t\tconst eventPath = path.join(eventDir, \`\${eventKey}.json\`);
\t\tfs.writeFileSync(eventPath, JSON.stringify(data), {
\t\t\tencoding: "utf8",
\t\t\tmode: 384
\t\t});
\t\texecFile(process.execPath, [
\t\t\tscript,
\t\t\t"event",
\t\t\t\`--event-file=\${eventPath}\`
\t\t], {
\t\t\ttimeout: 6e4,
\t\t\tmaxBuffer: 1024 * 1024,
\t\t\tenv: process.env
\t\t}, (err, stdout, stderr) => {
\t\t\tif (err) {
\t\t\t\treject(new Error(
\t\t\t\t\t\`AutoBoard event processor failed: \${err.message}; \${stderr?.trim() ?? ""}\`
\t\t\t\t));
\t\t\t\treturn;
\t\t\t}
\t\t\ttry { fs.unlinkSync(eventPath); } catch {}
\t\t\tlog(
\t\t\t\t\`feishu: AutoBoard \${label} event recorded (\${String(data.event_id ?? data.uuid ?? "unknown")}); \${stdout.trim()}\`
\t\t\t);
\t\t\tresolve();
\t\t});
\t});
\tautoBoardEventQueue = autoBoardEventQueue.catch(() => {}).then(task);
\treturn autoBoardEventQueue;
}
`;
  if (!source.includes(functionMarker)) {
    throw new Error("无法找到 registerEventHandlers");
  }
  if (source.includes(PREVIOUS_PATCH_MARKER)) {
    const previousBridge = new RegExp(
      `const ${PREVIOUS_PATCH_MARKER} = true;[\\\\s\\\\S]*?(?=${functionMarker.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")})`,
    );
    if (!previousBridge.test(source)) {
      throw new Error("发现旧版飞书事件补丁，但无法定位其桥接代码");
    }
    source = source.replace(previousBridge, bridge);
  } else if (
    source.includes("function enqueueAutoBoardBitableEvent") &&
    source.includes('"drive.file.bitable_record_changed_v1": async (data) => {')
  ) {
    const start = source.indexOf("const AUTOBOARD_BASE_TOKEN =");
    const end = source.indexOf(functionMarker);
    if (start < 0 || end < start) {
      throw new Error("发现旧版无标记事件桥接，但无法定位其代码");
    }
    source = `${source.slice(0, start)}${bridge}${source.slice(end)}`;
  } else {
    source = source.replace(functionMarker, `${bridge}${functionMarker}`);
  }

  const handlerMarker = '\t\t"im.message.reaction.created_v1": async (data) => {';
  const handler = `\t\t"drive.file.bitable_record_changed_v1": async (data) => {
\t\t\tawait runFeishuHandler({
\t\t\t\terrorMessage: \`feishu[\${accountId}]: error handling AutoBoard bitable event\`,
\t\t\t\ttask: () => enqueueAutoBoardBitableEvent(data, log)
\t\t\t});
\t\t},
`;
  if (source.includes('"drive.file.bitable_record_changed_v1": async (data) => {')) {
    return source;
  }
  if (!source.includes(handlerMarker)) {
    throw new Error("无法找到 Feishu 事件处理器插入位置");
  }
  return source.replace(handlerMarker, `${handler}${handlerMarker}`);
}

const { candidate, source } = await findMonitorFile();
if (CHECK_ONLY) {
  if (!source.includes(PATCH_MARKER)) {
    throw new Error(`Feishu 实时事件补丁尚未应用：${candidate}`);
  }
  console.log(JSON.stringify({ patched: true, file: candidate }));
  process.exit(0);
}

const next = patchedSource(source);
if (next === source) {
  console.log(JSON.stringify({ patched: true, unchanged: true, file: candidate }));
  process.exit(0);
}

try {
  await fs.access(`${candidate}.autoboard-original`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await fs.copyFile(candidate, `${candidate}.autoboard-original`);
}
await fs.writeFile(candidate, next, "utf8");
console.log(JSON.stringify({ patched: true, unchanged: false, file: candidate }));
