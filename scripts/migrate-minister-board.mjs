#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API = "https://open.feishu.cn";
const OPENCLAW_HOME =
  process.env.OPENCLAW_STATE_DIR ??
  path.join(process.env.OPENCLAW_HOME ?? os.homedir(), ".openclaw");
const CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ??
  path.join(OPENCLAW_HOME, "openclaw.json");
const BACKUP_DIR =
  process.env.AUTOBOARD_BACKUP_DIR ??
  path.resolve("outputs", "backups");
const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
};
const BASE_TOKEN = requiredEnv("AUTOBOARD_BASE_TOKEN");
const TASK_TABLE_ID = requiredEnv("AUTOBOARD_TASK_TABLE_ID");
const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const desiredFields = [
  {
    field_name: "督办领导",
    type: 1,
    description: { text: "领导或督办人的姓名。AI只在笔记中明确出现时填写，不猜测。" },
  },
  {
    field_name: "承接部门",
    type: 1,
    description: { text: "任务的主承接部门。AI只在原始信息明确时填写。" },
  },
  {
    field_name: "执行要求与标准依据",
    type: 1,
    description: { text: "面向协作人员展示的执行要求、补充要求和验收标准汇总。" },
  },
  {
    field_name: "前置关联任务",
    type: 18,
    property: { table_id: TASK_TABLE_ID, multiple: true },
    description: { text: "与本任务存在前置依赖关系的主表任务。" },
  },
  {
    field_name: "佐证附件",
    type: 17,
    description: { text: "过程材料、报告、照片、截图等任务完成佐证。" },
  },
];

const collaborationFields = [
  "任务编号",
  "任务标题",
  "来源类型",
  "任务类别",
  "优先级",
  "督办领导",
  "承接部门",
  "负责人",
  "负责人（飞书成员）",
  "计划开始时间",
  "截止时间",
  "任务状态",
  "完成比例",
  "前置关联任务",
  "执行要求与标准依据",
  "佐证附件",
];

const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
const feishu = config.channels?.feishu;
if (typeof feishu?.appId !== "string" || typeof feishu?.appSecret !== "string") {
  throw new Error("OpenClaw 配置中没有可用的飞书 appId/appSecret");
}

const authResponse = await fetch(`${API}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ app_id: feishu.appId, app_secret: feishu.appSecret }),
});
const auth = await authResponse.json();
if (!authResponse.ok || auth.code !== 0 || !auth.tenant_access_token) {
  throw new Error(`飞书认证失败: code=${auth.code}; ${auth.msg}`);
}
const tenantToken = auth.tenant_access_token;

async function request(apiPath, { method = "GET", body, retries = 5 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const response = await fetch(`${API}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json();
    if (response.ok && payload.code === 0) return payload.data ?? {};
    if ([1254290, 1254291, 1254608, 800030501, 800004135].includes(payload.code) && attempt < retries) {
      await sleep(700 * attempt);
      continue;
    }
    throw new Error(`${method} ${apiPath}: HTTP ${response.status}; code=${payload.code}; ${payload.msg}`);
  }
}

async function listAll(apiPath, pageSize = 500) {
  const items = [];
  let pageToken;
  do {
    const url = new URL(`${API}${apiPath}`);
    url.searchParams.set("page_size", String(pageSize));
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data = await request(`${url.pathname}${url.search}`);
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return items;
}

const taskBase = `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TASK_TABLE_ID}`;
const viewBase = `/open-apis/base/v3/bases/${BASE_TOKEN}/tables/${TASK_TABLE_ID}/views`;

async function readSnapshot() {
  const [fields, records, viewData] = await Promise.all([
    listAll(`${taskBase}/fields`, 100),
    listAll(`${taskBase}/records`, 500),
    request(`${viewBase}?limit=100`),
  ]);
  return { fields, records, views: viewData.views ?? [] };
}

function plainText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join("、");
  if (typeof value === "object" && typeof value.text === "string") return value.text.trim();
  return String(value).trim();
}

function combinedRequirement(fields) {
  const sections = [];
  const description = plainText(fields["任务说明"]);
  const notes = plainText(fields["备注要求"]);
  const acceptance = plainText(fields["验收标准"]);
  if (description) sections.push(`执行要求：${description}`);
  if (notes && notes !== description) sections.push(`补充要求：${notes}`);
  if (acceptance) sections.push(`标准依据/验收标准：${acceptance}`);
  return sections.join("\n");
}

function resolveDependencies(record, records) {
  const source = plainText(record.fields?.["前置依赖"]);
  if (!source) return [];
  const byNumber = new Map(records.map((item) => [plainText(item.fields?.["任务编号"]), item.record_id]));
  const byTitle = new Map(records.map((item) => [plainText(item.fields?.["任务标题"]), item.record_id]));
  const resolved = new Set();
  for (const [number, recordId] of byNumber) {
    if (number && source.includes(number) && recordId !== record.record_id) resolved.add(recordId);
  }
  const exactTitle = byTitle.get(source);
  if (exactTitle && exactTitle !== record.record_id) resolved.add(exactTitle);
  return [...resolved];
}

async function setView(viewId, segment, body) {
  await request(`${viewBase}/${viewId}/${segment}`, { method: "PUT", body });
  await sleep(150);
}

const before = await readSnapshot();
const existingNames = new Set(before.fields.map((field) => field.field_name));
const missingFields = desiredFields.filter((field) => !existingNames.has(field.field_name));
const plannedMigrations = before.records.map((record) => ({
  recordId: record.record_id,
  taskNumber: plainText(record.fields?.["任务编号"]),
  taskTitle: plainText(record.fields?.["任务标题"]),
  combinedRequirement: combinedRequirement(record.fields ?? {}),
  dependencyRecordIds: resolveDependencies(record, before.records),
}));
const existingLedger = before.views.find((view) => view.name === "部长协作台账");
const existingBoard = before.views.find((view) => view.name === "部长协作大看板");

const plan = {
  mode: APPLY ? "apply" : "dry-run",
  currentTaskRows: before.records.length,
  fieldsToCreate: missingFields.map((field) => field.field_name),
  recordsWithRequirementMigration: plannedMigrations.filter((item) => item.combinedRequirement).length,
  recordsWithResolvedDependencies: plannedMigrations.filter((item) => item.dependencyRecordIds.length).length,
  ledgerViewAction: existingLedger ? "update" : "create",
  collaborationBoardAction: existingBoard ? "update" : "missing",
};

if (!APPLY) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

await fs.mkdir(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const backupPath = path.join(BACKUP_DIR, `before-minister-board-migration-${timestamp}.json`);
await fs.writeFile(
  backupPath,
  JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), baseToken: BASE_TOKEN, ...before }, null, 2),
  { mode: 0o600 },
);

for (const definition of missingFields) {
  await request(`${taskBase}/fields`, { method: "POST", body: definition });
  await sleep(350);
}

for (const migration of plannedMigrations) {
  const fields = {};
  if (migration.combinedRequirement) fields["执行要求与标准依据"] = migration.combinedRequirement;
  if (migration.dependencyRecordIds.length) fields["前置关联任务"] = migration.dependencyRecordIds;
  if (!Object.keys(fields).length) continue;
  await request(`${taskBase}/records/${migration.recordId}`, { method: "PUT", body: { fields } });
  await sleep(120);
}

const fieldsAfterCreate = await listAll(`${taskBase}/fields`, 100);
const availableNames = new Set(fieldsAfterCreate.map((field) => field.field_name));
const visibleFields = collaborationFields.filter((name) => availableNames.has(name));

let ledgerView = existingLedger;
if (!ledgerView) {
  const created = await request(viewBase, { method: "POST", body: { name: "部长协作台账", type: "grid" } });
  ledgerView = created.view ?? created;
  await sleep(1000);
}
await setView(ledgerView.id, "visible_fields", { visible_fields: visibleFields });
await setView(ledgerView.id, "sort", {
  sort_config: [
    { field: fieldsAfterCreate.find((field) => field.field_name === "截止时间").field_id, desc: false },
    { field: fieldsAfterCreate.find((field) => field.field_name === "优先级").field_id, desc: false },
  ],
});

if (!existingBoard) throw new Error("未找到“部长协作大看板”，已停止，避免误建错误视图");
await setView(existingBoard.id, "visible_fields", { visible_fields: visibleFields });

const after = await readSnapshot();
const finalFieldNames = new Set(after.fields.map((field) => field.field_name));
const finalLedger = after.views.find((view) => view.name === "部长协作台账");
const finalBoard = after.views.find((view) => view.name === "部长协作大看板");
const migratedRequirements = after.records.filter((record) => plainText(record.fields?.["执行要求与标准依据"])).length;

console.log(
  JSON.stringify(
    {
      ...plan,
      result: {
        taskRowsBefore: before.records.length,
        taskRowsAfter: after.records.length,
        allDesiredFieldsPresent: desiredFields.every((field) => finalFieldNames.has(field.field_name)),
        migratedRequirements,
        ledgerView: finalLedger ? { id: finalLedger.id, name: finalLedger.name, type: finalLedger.type } : null,
        collaborationBoard: finalBoard ? { id: finalBoard.id, name: finalBoard.name, type: finalBoard.type } : null,
        backupPath,
      },
    },
    null,
    2,
  ),
);
