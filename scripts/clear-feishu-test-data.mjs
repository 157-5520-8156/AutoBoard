import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const openclawHome =
  process.env.OPENCLAW_STATE_DIR ??
  path.join(process.env.OPENCLAW_HOME ?? os.homedir(), ".openclaw");
const configPath =
  process.env.OPENCLAW_CONFIG_PATH ??
  path.join(openclawHome, "openclaw.json");
const outputDir =
  process.env.AUTOBOARD_BACKUP_DIR ??
  path.resolve("outputs", "backups");
const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
};
const baseToken = requiredEnv("AUTOBOARD_BASE_TOKEN");
const tables = {
  task: requiredEnv("AUTOBOARD_TASK_TABLE_ID"),
  progress: requiredEnv("AUTOBOARD_PROGRESS_TABLE_ID"),
  owner: requiredEnv("AUTOBOARD_OWNER_TABLE_ID"),
};
const preservedTaskViews = new Set([
  "表格",
  "总任务池",
  "DDL推进甘特图",
  "部长协作大看板",
]);
const apply = process.argv.includes("--apply");

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const appId = config.channels?.feishu?.appId;
const appSecret = config.channels?.feishu?.appSecret;
if (typeof appId !== "string" || typeof appSecret !== "string") {
  throw new Error("OpenClaw 中未找到可用的飞书 appId/appSecret");
}

async function api(method, apiPath, body) {
  const response = await fetch(`https://open.feishu.cn${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok || json.code !== 0) {
    throw new Error(`${method} ${apiPath} 失败: HTTP ${response.status}, code=${json.code}, msg=${json.msg}`);
  }
  return json.data ?? {};
}

const tokenResponse = await fetch(
  "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
  {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  },
);
const tokenJson = await tokenResponse.json();
if (!tokenResponse.ok || tokenJson.code !== 0 || !tokenJson.tenant_access_token) {
  throw new Error(`获取 tenant_access_token 失败: HTTP ${tokenResponse.status}, code=${tokenJson.code}, msg=${tokenJson.msg}`);
}
const tenantToken = tokenJson.tenant_access_token;

async function listAll(apiPath) {
  const items = [];
  let pageToken;
  do {
    const url = new URL(`https://open.feishu.cn${apiPath}`);
    url.searchParams.set("page_size", "500");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data = await api("GET", `${url.pathname}${url.search}`);
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function listFields(tableId) {
  return listAll(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields`);
}

async function listRecords(tableId) {
  return listAll(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`);
}

async function deleteRecords(tableId, records) {
  for (let index = 0; index < records.length; index += 500) {
    await api(
      "POST",
      `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_delete`,
      { records: records.slice(index, index + 500).map((record) => record.record_id ?? record.id) },
    );
  }
}

const [taskFields, taskRecords, progressFields, progressRecords, ownerFields, ownerRecords, taskViews] =
  await Promise.all([
    listFields(tables.task),
    listRecords(tables.task),
    listFields(tables.progress),
    listRecords(tables.progress),
    listFields(tables.owner),
    listRecords(tables.owner),
    listAll(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tables.task}/views`),
  ]);

const removableViews = taskViews.filter((view) => !preservedTaskViews.has(view.view_name ?? view.name));
const summary = {
  taskRows: taskRecords.length,
  progressRows: progressRecords.length,
  ownerRows: ownerRecords.length,
  removableViews: removableViews.map((view) => ({
    id: view.view_id ?? view.id,
    name: view.view_name ?? view.name,
    type: view.view_type ?? view.type,
  })),
  preservedViews: taskViews
    .filter((view) => preservedTaskViews.has(view.view_name ?? view.name))
    .map((view) => view.view_name ?? view.name),
};

if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", ...summary }, null, 2));
  process.exit(0);
}

await fs.mkdir(outputDir, { recursive: true });
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const backupPath = path.join(outputDir, `feishu-board-test-data-${timestamp}.json`);
await fs.writeFile(
  backupPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      baseToken,
      confirmedScope: summary,
      taskTable: { tableId: tables.task, fields: taskFields, records: taskRecords },
      progressTable: { tableId: tables.progress, fields: progressFields, records: progressRecords },
      ownerTable: { tableId: tables.owner, fields: ownerFields, records: ownerRecords },
      taskViews,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);

await deleteRecords(tables.progress, progressRecords);
await deleteRecords(tables.task, taskRecords);
await deleteRecords(tables.owner, ownerRecords);
for (const view of removableViews) {
  await api(
    "DELETE",
    `/open-apis/bitable/v1/apps/${baseToken}/tables/${tables.task}/views/${view.view_id ?? view.id}`,
  );
}

const [remainingTasks, remainingProgress, remainingOwners, remainingViews] = await Promise.all([
  listRecords(tables.task),
  listRecords(tables.progress),
  listRecords(tables.owner),
  listAll(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tables.task}/views`),
]);

console.log(
  JSON.stringify(
    {
      mode: "applied",
      deleted: summary,
      remaining: {
        taskRows: remainingTasks.length,
        progressRows: remainingProgress.length,
        ownerRows: remainingOwners.length,
        views: remainingViews.map((view) => view.view_name ?? view.name),
      },
      backupPath,
    },
    null,
    2,
  ),
);
