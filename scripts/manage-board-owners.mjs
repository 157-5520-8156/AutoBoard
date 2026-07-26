#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OPENCLAW_HOME =
  process.env.OPENCLAW_STATE_DIR ??
  path.join(process.env.OPENCLAW_HOME ?? os.homedir(), ".openclaw");
const CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ??
  path.join(OPENCLAW_HOME, "openclaw.json");
const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
};
const BASE_TOKEN = requiredEnv("AUTOBOARD_BASE_TOKEN");
const TASK_TABLE_ID = requiredEnv("AUTOBOARD_TASK_TABLE_ID");
const PROGRESS_TABLE_ID = requiredEnv("AUTOBOARD_PROGRESS_TABLE_ID");
const CONFIG_TABLE_NAME = "负责人配置表";
const API = "https://open.feishu.cn";
const now = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:
  manage-board-owners.mjs list
  manage-board-owners.mjs sync
  manage-board-owners.mjs add --name <负责人> [--open-id <ou_xxx>]
  manage-board-owners.mjs rename --old <旧名称> --new <新名称> [--open-id <ou_xxx>]
  manage-board-owners.mjs reassign --task <TASK-...> --to <负责人>
`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) usage();
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) usage(`Invalid argument: ${key ?? "<missing>"}`);
    options[key.slice(2)] = value;
  }
  return { command, options };
}

const { command, options } = parseArgs(process.argv.slice(2));
const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
const feishu = config.channels.feishu;

const authResponse = await fetch(`${API}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ app_id: feishu.appId, app_secret: feishu.appSecret }),
});
const auth = await authResponse.json();
if (!authResponse.ok || auth.code !== 0) throw new Error(`Feishu auth failed: ${auth.msg}`);
const token = auth.tenant_access_token;

async function request(path, { method = "GET", body, retries = 5 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json();
    if (response.ok && payload.code === 0) return payload.data ?? {};
    if (response.ok && payload.code === 800070003) return payload.data ?? {};
    if ([1254290, 1254291, 1254608, 800030501, 800004135].includes(payload.code) && attempt < retries) {
      await sleep(700 * attempt);
      continue;
    }
    throw new Error(`${method} ${path}: code=${payload.code}; ${payload.msg}`);
  }
}

const taskBase = `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TASK_TABLE_ID}`;
const progressBase = `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${PROGRESS_TABLE_ID}`;
const viewBase = `/open-apis/base/v3/bases/${BASE_TOKEN}/tables/${TASK_TABLE_ID}/views`;

const fieldData = await request(`${taskBase}/fields?page_size=100`);
const fieldIds = new Map(fieldData.items.map((item) => [item.field_name, item.field_id]));
const fieldId = (name) => {
  const id = fieldIds.get(name);
  if (!id) throw new Error(`Missing task field: ${name}`);
  return id;
};

async function ensureConfigTable() {
  const tableData = await request(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables?page_size=100`);
  let table = tableData.items.find((item) => item.name === CONFIG_TABLE_NAME);
  if (!table) {
    const created = await request(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`, {
      method: "POST",
      body: {
        table: {
          name: CONFIG_TABLE_NAME,
          default_view_name: "在任负责人",
          fields: [{ field_name: "负责人名称", type: 1 }],
        },
      },
    });
    table = created.table ?? created;
    await sleep(600);
  }
  const base = `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${table.table_id}`;
  const existing = await request(`${base}/fields?page_size=100`);
  const names = new Set(existing.items.map((item) => item.field_name));
  const definitions = [
    { field_name: "飞书OpenID", type: 1 },
    { field_name: "任职状态", type: 3, property: { options: [{ name: "在任", color: 0 }, { name: "停用", color: 1 }] } },
    { field_name: "个人看板名称", type: 1 },
    { field_name: "个人看板ID", type: 1 },
    { field_name: "最近同步时间", type: 5 },
    { field_name: "备注", type: 1 },
  ];
  for (const definition of definitions) {
    if (names.has(definition.field_name)) continue;
    await request(`${base}/fields`, { method: "POST", body: definition });
    await sleep(180);
  }
  return { id: table.table_id, base };
}

const configTable = await ensureConfigTable();

async function listViews() {
  const data = await request(`${viewBase}?limit=100`);
  return data.views;
}

async function listConfigRecords() {
  const data = await request(`${configTable.base}/records?page_size=500`);
  return data.items ?? [];
}

async function getConfig(owner) {
  return (await listConfigRecords()).find((item) => item.fields?.["负责人名称"] === owner);
}

async function setView(viewId, segment, body) {
  await request(`${viewBase}/${viewId}/${segment}`, { method: "PUT", body });
  await sleep(120);
}

const cardFields = [
  "任务标题", "任务编号", "负责人", "负责人（飞书成员）", "督办领导", "承接部门",
  "Sprint", "工作量点", "优先级", "风险等级", "计划开始时间", "截止时间",
  "完成比例", "执行要求与标准依据", "前置关联任务", "佐证附件",
];

async function ensureOwnerView(owner) {
  const viewName = `${owner}任务看板`;
  let view = (await listViews()).find((item) => item.name === viewName);
  let createdNow = false;
  if (!view) {
    const created = await request(viewBase, { method: "POST", body: { name: viewName, type: "kanban" } });
    view = created.view ?? created;
    createdNow = true;
    await sleep(1100);
  }
  if (createdNow) {
    await setView(view.id, "visible_fields", { visible_fields: cardFields });
    await setView(view.id, "group", { group_config: [{ field: fieldId("任务状态"), desc: false }] });
    await setView(view.id, "filter", {
      logic: "and",
      conditions: [[fieldId("负责人"), "==", owner]],
    });
    await setView(view.id, "sort", { sort_config: [{ field: fieldId("截止时间"), desc: false }] });
  }
  return { id: view.id, name: viewName };
}

async function upsertOwner(owner, openId = "", note = "") {
  if (!owner?.trim()) throw new Error("负责人名称不能为空");
  const normalized = owner.trim();
  const view = await ensureOwnerView(normalized);
  const record = await getConfig(normalized);
  const fields = {
    "负责人名称": normalized,
    "任职状态": "在任",
    "个人看板名称": view.name,
    "个人看板ID": view.id,
    "最近同步时间": now(),
    "备注": note,
    ...(openId ? { "飞书OpenID": openId } : {}),
  };
  if (record) {
    await request(`${configTable.base}/records/${record.record_id}`, { method: "PUT", body: { fields } });
  } else {
    await request(`${configTable.base}/records`, { method: "POST", body: { fields } });
  }
  if (openId) {
    try {
      await request(`/open-apis/drive/v1/permissions/${BASE_TOKEN}/members?type=bitable&need_notification=false`, {
        method: "POST",
        body: { member_type: "openid", member_id: openId, perm: "edit" },
      });
    } catch (error) {
      if (!/already|repeat|exist/i.test(String(error))) throw error;
    }
  }
  return { owner: normalized, openId: openId || record?.fields?.["飞书OpenID"] || "", view };
}

async function listTaskRecords() {
  const data = await request(`${taskBase}/records?page_size=500`);
  return data.items ?? [];
}

async function appendAdminLog(task, progress) {
  await request(`${progressBase}/records`, {
    method: "POST",
    body: {
      fields: {
        "更新标题": `${task.fields["任务编号"]} 负责人调整`,
        "任务编号": task.fields["任务编号"],
        "任务标题": task.fields["任务标题"],
        "负责人": progress.owner,
        "更新时间": now(),
        "本次进展": progress.text,
        "完成比例": Number(task.fields["完成比例"] ?? 0),
        "状态变更": "无变化",
        "下一步": task.fields["剩余事项"] ?? "",
        "当前卡点": task.fields["当前卡点"] ?? "",
        "更新人": "AI负责人管理",
        "来源消息ID": `owner_admin_${Date.now()}`,
      },
    },
  });
}

async function updateTaskOwner(task, owner, openId, changeText) {
  const fields = {
    "负责人": owner,
    "负责人（飞书成员）": openId ? [{ id: openId }] : null,
    "最后更新时间": now(),
  };
  await request(`${taskBase}/records/${task.record_id}`, { method: "PUT", body: { fields } });
  await appendAdminLog(task, { owner, text: changeText });
}

async function addOwner() {
  const owner = options.name;
  if (!owner) usage("add requires --name");
  const result = await upsertOwner(owner, options["open-id"] ?? "", "由AI新增负责人");
  console.log(JSON.stringify({ action: "add", configTableId: configTable.id, ...result }, null, 2));
}

async function syncOwners() {
  const tasks = await listTaskRecords();
  const owners = [...new Set(tasks.map((task) => task.fields?.["负责人"]).filter(Boolean))].sort();
  const results = [];
  for (const owner of owners) results.push(await upsertOwner(owner, "", "从任务主表自动同步"));
  console.log(JSON.stringify({ action: "sync", configTableId: configTable.id, owners: results }, null, 2));
}

async function renameOwner() {
  const oldName = options.old;
  const newName = options.new;
  if (!oldName || !newName) usage("rename requires --old and --new");
  if (oldName === newName) throw new Error("新旧名称相同，无需修改");

  const oldConfig = await getConfig(oldName);
  const openId = options["open-id"] ?? oldConfig?.fields?.["飞书OpenID"] ?? "";
  const newOwner = await upsertOwner(newName, openId, `由“${oldName}”更名`);
  const tasks = (await listTaskRecords()).filter((task) => task.fields?.["负责人"] === oldName);
  for (const task of tasks) {
    await updateTaskOwner(task, newName, openId, `负责人由“${oldName}”更名为“${newName}”`);
    await sleep(150);
  }
  if (oldConfig) {
    await request(`${configTable.base}/records/${oldConfig.record_id}`, {
      method: "PUT",
      body: { fields: { "任职状态": "停用", "最近同步时间": now(), "备注": `已更名为“${newName}”` } },
    });
  }
  const obsoleteView = (await listViews()).find((item) => item.name === `${oldName}任务看板`);
  if (obsoleteView && obsoleteView.id !== newOwner.view.id) {
    await request(`${viewBase}/${obsoleteView.id}`, { method: "DELETE" });
  }
  console.log(JSON.stringify({
    action: "rename",
    oldName,
    newName,
    affectedTasks: tasks.length,
    view: newOwner.view,
    obsoleteViewRemoved: Boolean(obsoleteView && obsoleteView.id !== newOwner.view.id),
  }, null, 2));
}

async function reassignTask() {
  const taskId = options.task;
  const target = options.to;
  if (!taskId || !target) usage("reassign requires --task and --to");
  const owner = await upsertOwner(target, "", "由AI在任务转交时同步");
  const task = (await listTaskRecords()).find((item) => item.fields?.["任务编号"] === taskId);
  if (!task) throw new Error(`找不到任务：${taskId}`);
  const oldName = task.fields?.["负责人"] ?? "未指定";
  await updateTaskOwner(task, target, owner.openId, `任务负责人由“${oldName}”调整为“${target}”`);
  console.log(JSON.stringify({ action: "reassign", taskId, oldName, newName: target, view: owner.view }, null, 2));
}

async function listOwners() {
  const records = await listConfigRecords();
  console.log(JSON.stringify({
    configTableId: configTable.id,
    owners: records.map((record) => ({ id: record.record_id, ...record.fields })),
  }, null, 2));
}

if (command === "list") await listOwners();
else if (command === "sync") await syncOwners();
else if (command === "add") await addOwner();
else if (command === "rename") await renameOwner();
else if (command === "reassign") await reassignTask();
else usage(`Unknown command: ${command}`);
