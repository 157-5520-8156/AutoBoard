#!/usr/bin/env node

import crypto from "node:crypto";
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
const STATE_DIR =
  process.env.AUTOBOARD_STATE_DIR ??
  path.join(OPENCLAW_HOME, "workspace", "state");
const STATE_PATH = path.join(STATE_DIR, "task-journal-snapshot.json");
const EVENT_DIR =
  process.env.AUTOBOARD_EVENT_DIR ??
  path.join(STATE_DIR, "bitable-events");
const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
};
const BASE_TOKEN = requiredEnv("AUTOBOARD_BASE_TOKEN");
const TASK_TABLE_ID = requiredEnv("AUTOBOARD_TASK_TABLE_ID");
const JOURNAL_TABLE_NAME = "任务工作日记";
const TIME_ZONE = "Asia/Shanghai";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const command = process.argv[2] ?? "status";
const dateArgument = process.argv.find((item) => item.startsWith("--date="))?.slice(7);
const eventFileArgument = process.argv.find((item) => item.startsWith("--event-file="))?.slice(13);
const allowCurrentSummary = process.argv.includes("--allow-current");

const trackedFields = [
  "任务编号",
  "任务标题",
  "负责人",
  "负责人（飞书成员）",
  "督办领导",
  "承接部门",
  "任务状态",
  "完成比例",
  "计划开始时间",
  "截止时间",
  "下次跟进时间",
  "优先级",
  "风险等级",
  "最新进展",
  "剩余事项",
  "当前卡点",
  "是否已通知",
  "执行要求与标准依据",
  "佐证附件",
];

const fieldDefinitions = [
  {
    field_name: "日记日期",
    type: 5,
    property: { auto_fill: true, date_formatter: "yyyy/MM/dd" },
  },
  {
    field_name: "记录时间",
    type: 5,
    property: { auto_fill: true, date_formatter: "yyyy/MM/dd HH:mm" },
  },
  {
    field_name: "日期分组",
    type: 3,
    property: { options: [{ name: dateKey(), color: 0 }] },
  },
  {
    field_name: "记录类型",
    type: 3,
    property: {
      options: [
        { name: "自动变更", color: 0 },
        { name: "每日汇总", color: 1 },
        { name: "手工备注", color: 2 },
        { name: "重要事件", color: 3 },
        { name: "会议纪要", color: 4 },
        { name: "风险问题", color: 5 },
      ],
    },
  },
  { field_name: "记录内容", type: 1 },
  { field_name: "关联任务编号", type: 1 },
  {
    field_name: "关联任务",
    type: 18,
    property: { table_id: TASK_TABLE_ID, multiple: true },
  },
  { field_name: "负责人", type: 1 },
  { field_name: "变更字段", type: 1 },
  { field_name: "变更前", type: 1 },
  { field_name: "变更后", type: 1 },
  {
    field_name: "来源",
    type: 3,
    property: {
      options: [
        { name: "自动监测", color: 0 },
        { name: "看板拖动", color: 1 },
        { name: "OpenClaw对话", color: 2 },
        { name: "用户手工", color: 3 },
        { name: "定时汇总", color: 4 },
      ],
    },
  },
  { field_name: "记录人", type: 1 },
  { field_name: "来源消息ID", type: 1 },
  { field_name: "变更标识", type: 1 },
  { field_name: "是否纳入日报", type: 7 },
  { field_name: "附件", type: 17 },
  { field_name: "创建时间", type: 1001 },
  { field_name: "创建人", type: 1003 },
];
const requiredJournalFields = [
  "日记标题",
  ...fieldDefinitions.map((field) => field.field_name),
];
const requiredJournalSchema = [
  { name: "日记标题", type: 1 },
  ...fieldDefinitions.map((field) => ({
    name: field.field_name,
    type: field.type,
    ...(field.type === 18
      ? {
          relation: {
            tableId: field.property.table_id,
            multiple: field.property.multiple,
          },
        }
      : {}),
  })),
];

const visibleFields = [
  "日记日期",
  "日期分组",
  "记录时间",
  "记录类型",
  "日记标题",
  "记录内容",
  "关联任务编号",
  "关联任务",
  "负责人",
  "变更字段",
  "来源",
  "记录人",
  "附件",
  "创建时间",
  "创建人",
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
    let response;
    let payload;
    try {
      response = await fetch(`${API}${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${tenantToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const responseText = await response.text();
      payload = responseText ? JSON.parse(responseText) : {};
    } catch (error) {
      if (attempt < retries) {
        await sleep(700 * attempt);
        continue;
      }
      throw new Error(
        `${method} ${apiPath}: 飞书请求或响应解析失败（重试 ${retries} 次）`,
        { cause: error },
      );
    }
    if (response.ok && payload.code === 0) return payload.data ?? {};
    if (response.ok && payload.code === 800070003) return payload.data ?? {};
    const retryableStatus = response.status === 429 || response.status >= 500;
    const retryableCode = [
      1254290,
      1254291,
      1254607,
      1254608,
      800030501,
      800004135,
    ].includes(payload.code);
    if ((retryableStatus || retryableCode) && attempt < retries) {
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

async function findJournalTable() {
  const tables = await listAll(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`, 100);
  return tables.find((table) => table.name === JOURNAL_TABLE_NAME);
}

async function getJournalContext() {
  const table = await findJournalTable();
  if (!table) throw new Error(`未找到“${JOURNAL_TABLE_NAME}”，请先运行 setup`);
  return {
    table,
    tableBase: `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${table.table_id}`,
  };
}

async function ensureJournalTable() {
  let table = await findJournalTable();
  if (!table) {
    const created = await request(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables`, {
      method: "POST",
      body: {
        table: {
          name: JOURNAL_TABLE_NAME,
          default_view_name: "日记与事件",
          fields: [{ field_name: "日记标题", type: 1 }],
        },
      },
    });
    table = created.table ?? created;
    await sleep(800);
  }

  const tableBase = `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${table.table_id}`;
  let fields = await listAll(`${tableBase}/fields`, 100);
  const names = new Set(fields.map((field) => field.field_name));
  for (const definition of fieldDefinitions) {
    if (names.has(definition.field_name)) continue;
    await request(`${tableBase}/fields`, { method: "POST", body: definition });
    await sleep(250);
  }
  fields = await listAll(`${tableBase}/fields`, 100);

  const fieldIds = new Map(fields.map((field) => [field.field_name, field.field_id]));
  const viewBase = `/open-apis/base/v3/bases/${BASE_TOKEN}/tables/${table.table_id}/views`;
  const listViews = async () => (await request(`${viewBase}?limit=100`)).views ?? [];

  async function ensureView(name, type = "grid") {
    let view = (await listViews()).find((item) => item.name === name);
    if (!view) {
      const created = await request(viewBase, { method: "POST", body: { name, type } });
      view = created.view ?? created;
      await sleep(900);
    }
    return view;
  }

  async function setView(viewId, segment, body) {
    await request(`${viewBase}/${viewId}/${segment}`, { method: "PUT", body });
    await sleep(150);
  }

  const views = {
    journal: await ensureView("日记与事件"),
    dailyBoard: await ensureView("日记按天看板", "kanban"),
    automatic: await ensureView("自动变更"),
    summary: await ensureView("每日汇总"),
    manual: await ensureView("手工记录"),
  };

  for (const view of [views.journal, views.automatic, views.summary, views.manual, views.dailyBoard]) {
    await setView(view.id, "visible_fields", {
      visible_fields: visibleFields.filter((name) => fieldIds.has(name)),
    });
    await setView(view.id, "sort", {
      sort_config: [{ field: fieldIds.get("记录时间"), desc: true }],
    });
  }
  await setView(views.dailyBoard.id, "group", {
    group_config: [{ field: fieldIds.get("日期分组"), desc: true }],
  });
  await setView(views.automatic.id, "filter", {
    logic: "and",
    conditions: [[fieldIds.get("记录类型"), "==", "自动变更"]],
  });
  await setView(views.summary.id, "filter", {
    logic: "and",
    conditions: [[fieldIds.get("记录类型"), "==", "每日汇总"]],
  });
  await setView(views.manual.id, "filter", {
    logic: "or",
    conditions: [
      [fieldIds.get("记录类型"), "==", "手工备注"],
      [fieldIds.get("记录类型"), "==", "重要事件"],
      [fieldIds.get("记录类型"), "==", "会议纪要"],
      [fieldIds.get("记录类型"), "==", "风险问题"],
    ],
  });

  return { table, tableBase, fields, views };
}

function zonedDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { year: get("year"), month: get("month"), day: get("day") };
}

function dateKey(date = new Date()) {
  const parts = zonedDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localMidnightTimestamp(key) {
  return Date.parse(`${key}T00:00:00+08:00`);
}

function previousDateKey() {
  const now = Date.now();
  return dateKey(new Date(now - 24 * 60 * 60 * 1000));
}

function normalize(value) {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) {
    return value
      .map(normalize)
      .filter((item) => item !== null)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["avatar_url", "en_name"].includes(key))
        .map(([key, nested]) => [key, normalize(nested)])
        .filter(([, nested]) => nested !== null)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}

function display(value) {
  const normalized = normalize(value);
  if (normalized === null) return "（空）";
  if (typeof normalized === "number" && normalized > 1_000_000_000_000) {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(normalized));
  }
  if (typeof normalized === "object") return JSON.stringify(normalized);
  return String(normalized);
}

function snapshotRecord(record) {
  const fields = {};
  for (const name of trackedFields) fields[name] = normalize(record.fields?.[name]);
  return {
    recordId: record.record_id,
    fields,
  };
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const temporary = `${STATE_PATH}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(temporary, STATE_PATH);
}

async function listTasks() {
  return listAll(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TASK_TABLE_ID}/records`, 500);
}

async function listJournalRecords(journal) {
  return listAll(`${journal.tableBase}/records`, 500);
}

async function ensureDateGroupOptions(journal, keys) {
  const wanted = [...new Set(keys.filter(Boolean))].sort();
  if (!wanted.length) return;
  const fields = await listAll(`${journal.tableBase}/fields`, 100);
  const groupField = fields.find((field) => field.field_name === "日期分组");
  if (!groupField) throw new Error("任务工作日记缺少“日期分组”字段");
  const options = groupField.property?.options ?? [];
  const existingNames = new Set(options.map((option) => option.name));
  const missing = wanted.filter((key) => !existingNames.has(key));
  if (!missing.length) return;
  await request(`${journal.tableBase}/fields/${groupField.field_id}`, {
    method: "PUT",
    body: {
      field_name: "日期分组",
      type: 3,
      property: {
        options: [
          ...options.map((option) => ({
            id: option.id,
            name: option.name,
            color: option.color,
          })),
          ...missing.map((name, index) => ({ name, color: (options.length + index) % 8 })),
        ],
      },
    },
  });
}

async function reconcileDateGroups(journal, records) {
  const pending = records.map((record) => {
    const group = record.fields?.["日期分组"];
    const date = record.fields?.["日记日期"];
    const dateGroup = date ? dateKey(new Date(Number(date))) : null;
    if (group && /^\d{4}-\d{2}-\d{2}$/.test(group) && group !== dateGroup) {
      return { record, group, dateTimestamp: localMidnightTimestamp(group), action: "align-date" };
    }
    if (!group && dateGroup) {
      return { record, group: dateGroup, dateTimestamp: null, action: "fill-group" };
    }
    return null;
  }).filter(Boolean);
  if (!pending.length) return { groupsFilled: 0, datesAligned: 0 };
  await ensureDateGroupOptions(journal, pending.map((item) => item.group));
  for (const { record, group, dateTimestamp, action } of pending) {
    const fields = action === "align-date"
      ? { "日记日期": dateTimestamp }
      : { "日期分组": group };
    await request(`${journal.tableBase}/records/${record.record_id}`, {
      method: "PUT",
      body: { fields },
    });
    await sleep(100);
  }
  return {
    groupsFilled: pending.filter((item) => item.action === "fill-group").length,
    datesAligned: pending.filter((item) => item.action === "align-date").length,
  };
}

async function createJournalRecord(journal, fields) {
  if (fields["日记日期"] && !fields["日期分组"]) {
    fields["日期分组"] = dateKey(new Date(Number(fields["日记日期"])));
  }
  if (fields["日期分组"]) await ensureDateGroupOptions(journal, [fields["日期分组"]]);
  return request(`${journal.tableBase}/records`, {
    method: "POST",
    body: { fields },
  });
}

function parseEventFieldValue(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return normalize(value);
  try {
    return normalize(JSON.parse(value));
  } catch {
    return normalize(value);
  }
}

function resolveEventFieldValue(value, field) {
  if (
    field?.type === 1 &&
    Array.isArray(value) &&
    value.every((item) => item && typeof item === "object" && typeof item.text === "string")
  ) {
    return value.map((item) => item.text).join("");
  }
  const options = field?.property?.options ?? [];
  if (!options.length) return value;
  const namesById = new Map(options.map((option) => [option.id, option.name]));
  if (Array.isArray(value)) {
    return value.map((item) => namesById.get(item) ?? item);
  }
  return namesById.get(value) ?? value;
}

function eventValueMap(values, fieldsById) {
  const result = new Map();
  for (const item of values ?? []) {
    const field = fieldsById.get(item.field_id);
    if (!field?.field_name) continue;
    const identityUsers = item.field_identity_value?.users;
    const parsedValue = identityUsers?.length
      ? normalize(identityUsers)
      : parseEventFieldValue(item.field_value);
    result.set(
      field.field_name,
      resolveEventFieldValue(parsedValue, field),
    );
  }
  return result;
}

function eventTimestamp(event) {
  const raw = Number(event.update_time ?? event.ts ?? event.create_time);
  if (!Number.isFinite(raw) || raw <= 0) return Date.now();
  return raw < 10_000_000_000 ? raw * 1000 : raw;
}

async function getTaskRecord(recordId) {
  try {
    const data = await request(
      `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TASK_TABLE_ID}/records/${recordId}`,
    );
    return data.record ?? data;
  } catch (error) {
    if (/code=(1254043|1254044|1254045|1254046)/.test(String(error))) return null;
    throw error;
  }
}

async function updateSnapshotFromEvent(recordId, task) {
  const state = (await readState()) ?? {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    records: {},
  };
  if (task?.record_id) state.records[recordId] = snapshotRecord(task);
  else delete state.records[recordId];
  state.capturedAt = new Date().toISOString();
  await writeState(state);
}

async function processBitableEvent(eventPath = eventFileArgument) {
  if (!eventPath) throw new Error("event 命令缺少 --event-file");
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  if (event.file_token !== BASE_TOKEN || event.table_id !== TASK_TABLE_ID) {
    console.log(JSON.stringify({ action: "event", ignored: true, reason: "different-table" }, null, 2));
    return;
  }

  const journal = await getJournalContext();
  const [taskFields, existingJournal] = await Promise.all([
    listAll(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TASK_TABLE_ID}/fields`, 100),
    listJournalRecords(journal),
  ]);
  const fieldsById = new Map(taskFields.map((field) => [field.field_id, field]));
  const existingChangeIds = new Set(
    existingJournal.map((record) => record.fields?.["变更标识"]).filter(Boolean),
  );
  const recordedAt = eventTimestamp(event);
  const operator =
    event.operator_id?.open_id ??
    event.operator_id?.user_id ??
    event.operator_id?.union_id ??
    "飞书事件自动化";
  let changesLogged = 0;

  for (const [actionIndex, action] of (event.action_list ?? []).entries()) {
    const recordId = action.record_id;
    if (!recordId) continue;
    const changeId = `feishu-event-${event.event_id ?? event.uuid ?? hash(JSON.stringify(event))}-${recordId}-${actionIndex}`;
    if (existingChangeIds.has(changeId)) continue;

    const before = eventValueMap(action.before_value, fieldsById);
    const after = eventValueMap(action.after_value, fieldsById);
    const changes = [];
    for (const name of trackedFields) {
      if (!before.has(name) && !after.has(name)) continue;
      const beforeValue = before.get(name) ?? null;
      const afterValue = after.get(name) ?? null;
      if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
      changes.push({ name, before: beforeValue, after: afterValue });
    }
    if (!changes.length) continue;

    const task = await getTaskRecord(recordId);
    const taskNumber =
      display(task?.fields?.["任务编号"] ?? after.get("任务编号") ?? before.get("任务编号"))
        .replace("（空）", "");
    const taskTitle =
      display(task?.fields?.["任务标题"] ?? after.get("任务标题") ?? before.get("任务标题"))
        .replace("（空）", "");
    const owner =
      display(task?.fields?.["负责人"] ?? after.get("负责人") ?? before.get("负责人"))
        .replace("（空）", "");
    const isStatusMove = changes.length === 1 && changes[0].name === "任务状态";
    const actionLabel = /delete|remove/i.test(action.action ?? "")
      ? "任务移除"
      : /add|create/i.test(action.action ?? "")
        ? "新增任务"
        : "任务变更";

    await createJournalRecord(journal, {
      "日记标题": `${actionLabel}：${taskTitle || taskNumber || recordId}`,
      "日记日期": localMidnightTimestamp(dateKey(new Date(recordedAt))),
      "记录时间": recordedAt,
      "记录类型": "自动变更",
      "记录内容": changes
        .map((change) => `${change.name}：${display(change.before)} → ${display(change.after)}`)
        .join("\n"),
      "关联任务编号": taskNumber,
      ...(task?.record_id ? { "关联任务": [task.record_id] } : {}),
      "负责人": owner,
      "变更字段": changes.map((change) => change.name).join("、"),
      "变更前": changes.map((change) => `${change.name}=${display(change.before)}`).join("\n"),
      "变更后": changes.map((change) => `${change.name}=${display(change.after)}`).join("\n"),
      "来源": isStatusMove ? "看板拖动" : "自动监测",
      "记录人": operator,
      "来源消息ID": event.event_id ?? event.uuid ?? "",
      "变更标识": changeId,
      "是否纳入日报": true,
    });
    existingChangeIds.add(changeId);
    changesLogged += 1;
    await updateSnapshotFromEvent(recordId, task);
  }

  console.log(
    JSON.stringify(
      {
        action: "event",
        eventId: event.event_id ?? event.uuid ?? null,
        tableId: event.table_id,
        changesLogged,
        processedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function readRetryState(retryPath) {
  try {
    return JSON.parse(await fs.readFile(retryPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { attempts: 0 };
    return { attempts: 0 };
  }
}

async function drainPendingEvents({ maxAttempts = 10 } = {}) {
  await fs.mkdir(EVENT_DIR, { recursive: true });
  const entries = (await fs.readdir(EVENT_DIR, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.endsWith(".retry.json"),
    )
    .map((entry) => entry.name)
    .sort();
  let processed = 0;
  let deferred = 0;
  let deadLettered = 0;

  for (const name of entries) {
    const eventPath = path.join(EVENT_DIR, name);
    const retryPath = `${eventPath}.retry.json`;
    try {
      await processBitableEvent(eventPath);
      await fs.unlink(eventPath);
      await fs.rm(retryPath, { force: true });
      processed += 1;
    } catch (error) {
      const previous = await readRetryState(retryPath);
      const attempts = Number(previous.attempts ?? 0) + 1;
      const failure = {
        attempts,
        lastAttemptAt: new Date().toISOString(),
        error: String(error?.message ?? error),
      };
      if (attempts >= maxAttempts) {
        const deadLetterDir = path.join(EVENT_DIR, "dead-letter");
        await fs.mkdir(deadLetterDir, { recursive: true });
        await fs.rename(eventPath, path.join(deadLetterDir, name));
        await fs.writeFile(
          path.join(deadLetterDir, `${name}.error.json`),
          `${JSON.stringify(failure, null, 2)}\n`,
          { mode: 0o600 },
        );
        await fs.rm(retryPath, { force: true });
        deadLettered += 1;
      } else {
        await fs.writeFile(
          retryPath,
          `${JSON.stringify(failure, null, 2)}\n`,
          { mode: 0o600 },
        );
        deferred += 1;
      }
    }
  }

  const result = {
    action: "drain-events",
    found: entries.length,
    processed,
    deferred,
    deadLettered,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function eventQueueStatus() {
  const entries = await fs
    .readdir(EVENT_DIR, { withFileTypes: true })
    .catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
  const deadLetterDir = path.join(EVENT_DIR, "dead-letter");
  const deadLetterEntries = await fs
    .readdir(deadLetterDir, { withFileTypes: true })
    .catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
  return {
    pending: entries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.endsWith(".retry.json"),
    ).length,
    retryMetadata: entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".retry.json"),
    ).length,
    deadLetters: deadLetterEntries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.endsWith(".error.json"),
    ).length,
  };
}

async function retryDeadLetters() {
  const deadLetterDir = path.join(EVENT_DIR, "dead-letter");
  const entries = await fs
    .readdir(deadLetterDir, { withFileTypes: true })
    .catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
  await fs.mkdir(EVENT_DIR, { recursive: true });
  let restored = 0;
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json") ||
      entry.name.endsWith(".error.json")
    ) {
      continue;
    }
    const source = path.join(deadLetterDir, entry.name);
    const destination = path.join(EVENT_DIR, entry.name);
    try {
      await fs.access(destination);
      throw new Error(`待处理目录已存在同名事件：${entry.name}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(source, destination);
    await fs.rm(path.join(deadLetterDir, `${entry.name}.error.json`), {
      force: true,
    });
    restored += 1;
  }
  console.log(JSON.stringify({ action: "retry-dead-letters", restored }, null, 2));
}

async function setup() {
  const journal = await ensureJournalTable();
  console.log(
    JSON.stringify(
      {
        action: "setup",
        tableId: journal.table.table_id,
        fields: journal.fields.length,
        views: Object.fromEntries(
          Object.entries(journal.views).map(([key, view]) => [key, { id: view.id, name: view.name }]),
        ),
      },
      null,
      2,
    ),
  );
}

async function baseline() {
  const tasks = await listTasks();
  await writeState({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    records: Object.fromEntries(tasks.map((record) => [record.record_id, snapshotRecord(record)])),
  });
  console.log(JSON.stringify({ action: "baseline", taskRows: tasks.length, statePath: STATE_PATH }, null, 2));
}

async function sync() {
  const journal = await getJournalContext();
  const [tasks, state, existingJournal] = await Promise.all([
    listTasks(),
    readState(),
    listJournalRecords(journal),
  ]);
  const dateReconciliation = await reconcileDateGroups(journal, existingJournal);
  if (!state) {
    await baseline();
    console.log(JSON.stringify({ action: "sync", baselineCreated: true, changesLogged: 0 }, null, 2));
    return;
  }

  const existingChangeIds = new Set(
    existingJournal.map((record) => record.fields?.["变更标识"]).filter(Boolean),
  );
  const previous = state.records ?? {};
  const current = Object.fromEntries(tasks.map((record) => [record.record_id, snapshotRecord(record)]));
  let changesLogged = 0;
  const now = Date.now();
  const today = dateKey(new Date(now));

  for (const task of tasks) {
    const before = previous[task.record_id];
    const after = current[task.record_id];
    const taskNumber = display(after.fields["任务编号"]).replace("（空）", "");
    const taskTitle = display(after.fields["任务标题"]).replace("（空）", "");
    const owner = display(after.fields["负责人"]).replace("（空）", "");
    const changes = [];

    if (!before) {
      for (const name of trackedFields) {
        if (after.fields[name] !== null) changes.push({ name, before: null, after: after.fields[name] });
      }
    } else {
      for (const name of trackedFields) {
        if (JSON.stringify(before.fields[name]) !== JSON.stringify(after.fields[name])) {
          changes.push({ name, before: before.fields[name], after: after.fields[name] });
        }
      }
    }
    if (!changes.length) continue;

    const changeId = `task-change-${hash(
      JSON.stringify({ recordId: task.record_id, before: before?.fields ?? null, after: after.fields }),
    )}`;
    if (existingChangeIds.has(changeId)) continue;

    const isBoardDrag = changes.length === 1 && changes[0].name === "任务状态";
    const content = changes
      .map((change) => `${change.name}：${display(change.before)} → ${display(change.after)}`)
      .join("\n");
    await createJournalRecord(journal, {
      "日记标题": `${before ? "任务变更" : "新增任务"}：${taskTitle || taskNumber || task.record_id}`,
      "日记日期": localMidnightTimestamp(today),
      "记录时间": now,
      "记录类型": "自动变更",
      "记录内容": content,
      "关联任务编号": taskNumber,
      "关联任务": [task.record_id],
      "负责人": owner,
      "变更字段": changes.map((change) => change.name).join("、"),
      "变更前": changes.map((change) => `${change.name}=${display(change.before)}`).join("\n"),
      "变更后": changes.map((change) => `${change.name}=${display(change.after)}`).join("\n"),
      "来源": isBoardDrag ? "看板拖动" : "自动监测",
      "记录人": "OpenClaw自动化",
      "变更标识": changeId,
      "是否纳入日报": true,
    });
    existingChangeIds.add(changeId);
    changesLogged += 1;
    await sleep(120);
  }

  for (const [recordId, oldRecord] of Object.entries(previous)) {
    if (current[recordId]) continue;
    const taskNumber = display(oldRecord.fields["任务编号"]).replace("（空）", "");
    const taskTitle = display(oldRecord.fields["任务标题"]).replace("（空）", "");
    const changeId = `task-removed-${hash(JSON.stringify(oldRecord))}`;
    if (existingChangeIds.has(changeId)) continue;
    await createJournalRecord(journal, {
      "日记标题": `任务从主表移除：${taskTitle || taskNumber || recordId}`,
      "日记日期": localMidnightTimestamp(today),
      "记录时间": now,
      "记录类型": "自动变更",
      "记录内容": "自动监测发现该任务记录已不在任务主表中。",
      "关联任务编号": taskNumber,
      "负责人": display(oldRecord.fields["负责人"]).replace("（空）", ""),
      "变更字段": "记录状态",
      "变更前": "存在",
      "变更后": "不存在",
      "来源": "自动监测",
      "记录人": "OpenClaw自动化",
      "变更标识": changeId,
      "是否纳入日报": true,
    });
    changesLogged += 1;
  }

  await writeState({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    records: current,
  });
  console.log(
    JSON.stringify(
      {
        action: "sync",
        taskRows: tasks.length,
        changesLogged,
        dateGroupsBackfilled: dateReconciliation.groupsFilled,
        datesAlignedFromBoard: dateReconciliation.datesAligned,
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function recover() {
  const drainResult = await drainPendingEvents();
  await sync();
  if (drainResult.deferred > 0 || drainResult.deadLettered > 0) {
    throw new Error(
      `事件补偿未完全成功：deferred=${drainResult.deferred}; deadLettered=${drainResult.deadLettered}`,
    );
  }
}

async function summary() {
  const journal = await getJournalContext();
  const targetDate = dateArgument ?? previousDateKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error("--date 必须是 YYYY-MM-DD");
  if (targetDate >= dateKey() && !allowCurrentSummary) {
    throw new Error("每日汇总只能生成已结束日期；如确需预览当天汇总，请显式传入 --allow-current");
  }

  const records = await listJournalRecords(journal);
  const summaryId = `daily-summary-${targetDate}`;
  const existingSummary = records.find((record) => record.fields?.["变更标识"] === summaryId);
  const dayEntries = records.filter((record) => {
    const type = record.fields?.["记录类型"];
    const date = record.fields?.["日记日期"];
    const included = record.fields?.["是否纳入日报"] !== false;
    return type !== "每日汇总" && included && date && dateKey(new Date(Number(date))) === targetDate;
  });
  if (!dayEntries.length && !existingSummary) {
    console.log(JSON.stringify({ action: "summary", targetDate, entries: 0, skipped: "no-entries" }, null, 2));
    return;
  }
  const counts = new Map();
  for (const entry of dayEntries) {
    const type = entry.fields?.["记录类型"] ?? "未分类";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const lines = [
    `共记录 ${dayEntries.length} 项。`,
    ...[...counts.entries()].map(([type, count]) => `${type}：${count} 项`),
    "",
    ...dayEntries.map((entry, index) => {
      const time = entry.fields?.["记录时间"]
        ? new Intl.DateTimeFormat("zh-CN", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(Number(entry.fields["记录时间"])))
        : "--:--";
      return `${index + 1}. ${time} ${entry.fields?.["日记标题"] ?? "未命名记录"}`;
    }),
  ];
  const fields = {
    "日记标题": `${targetDate} 任务工作日报`,
    "日记日期": localMidnightTimestamp(targetDate),
    "记录时间": Date.now(),
    "记录类型": "每日汇总",
    "记录内容": lines.join("\n"),
    "来源": "定时汇总",
    "记录人": "OpenClaw自动化",
    "变更标识": summaryId,
    "是否纳入日报": false,
  };
  if (existingSummary) {
    await request(`${journal.tableBase}/records/${existingSummary.record_id}`, {
      method: "PUT",
      body: { fields },
    });
  } else {
    await createJournalRecord(journal, fields);
  }
  console.log(
    JSON.stringify(
      { action: "summary", targetDate, entries: dayEntries.length, updated: Boolean(existingSummary) },
      null,
      2,
    ),
  );
}

async function status() {
  const table = await findJournalTable();
  const state = await readState();
  const result = {
    action: "status",
    journalTable: table ? { id: table.table_id, name: table.name } : null,
    snapshot: state ? { capturedAt: state.capturedAt, taskRows: Object.keys(state.records ?? {}).length } : null,
    eventQueue: await eventQueueStatus(),
  };
  if (table) {
    const tableBase = `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${table.table_id}`;
    const viewBase = `/open-apis/base/v3/bases/${BASE_TOKEN}/tables/${table.table_id}/views`;
    const [fields, records, viewData] = await Promise.all([
      listAll(`${tableBase}/fields`, 100),
      listAll(`${tableBase}/records`, 500),
      request(`${viewBase}?limit=100`),
    ]);
    const views = viewData.views ?? [];
    const dailyBoard = views.find((view) => view.name === "日记按天看板");
    const groupData = dailyBoard
      ? await request(`${viewBase}/${dailyBoard.id}/group`)
      : null;
    const fieldsById = new Map(
      fields.map((field) => [field.field_id, field.field_name]),
    );
    const groupConfig = Array.isArray(groupData)
      ? groupData
      : (groupData?.group_config ?? []);
    result.journalTable.fields = fields.length;
    result.journalTable.fieldNames = fields.map((field) => field.field_name);
    result.journalTable.fieldSchema = fields.map((field) => ({
      name: field.field_name,
      type: field.type,
      ...(field.type === 18
        ? {
            relation: {
              tableId: field.property?.table_id,
              multiple: field.property?.multiple,
            },
          }
        : {}),
    }));
    result.journalTable.records = records.length;
    result.dailyBoard = dailyBoard
      ? {
          id: dailyBoard.id,
          type: dailyBoard.type,
          groupFields: groupConfig
            .map((group) => fieldsById.get(group.field) ?? group.field)
            .filter(Boolean),
        }
      : null;
    result.requiredFieldNames = requiredJournalFields;
    result.requiredFieldSchema = requiredJournalSchema;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function selfTest() {
  const originalState = await readState();
  if (!originalState) throw new Error("缺少初始快照，请先运行 baseline");
  const tasks = await listTasks();
  const target = tasks[0];
  if (!target) throw new Error("任务主表为空，无法执行关联记录自检");
  const testState = structuredClone(originalState);
  delete testState.records[target.record_id];
  await writeState(testState);

  try {
    await sync();
    const journal = await getJournalContext();
    const records = await listJournalRecords(journal);
    const taskNumber = display(target.fields?.["任务编号"]).replace("（空）", "");
    const testRecord = records.find(
      (record) =>
        record.fields?.["记录类型"] === "自动变更" &&
        record.fields?.["关联任务编号"] === taskNumber &&
        String(record.fields?.["日记标题"] ?? "").startsWith("新增任务："),
    );
    if (!testRecord) throw new Error("自动变更记录未生成");
    if (!testRecord.fields?.["关联任务"]?.length) throw new Error("自动变更记录未关联任务");
    await request(`${journal.tableBase}/records/${testRecord.record_id}`, { method: "DELETE" });
    console.log(
      JSON.stringify(
        {
          action: "self-test",
          passed: true,
          checked: ["任务差异检测", "自动日志创建", "任务关联写入", "测试记录清理"],
          taskRecordId: target.record_id,
        },
        null,
        2,
      ),
    );
  } finally {
    await writeState(originalState);
  }
}

switch (command) {
  case "setup":
    await setup();
    break;
  case "baseline":
    await baseline();
    break;
  case "sync":
    await sync();
    break;
  case "recover":
    await recover();
    break;
  case "drain-events":
    await drainPendingEvents();
    break;
  case "retry-dead-letters":
    await retryDeadLetters();
    break;
  case "event":
    await processBitableEvent();
    break;
  case "summary":
    await summary();
    break;
  case "status":
    await status();
    break;
  case "self-test":
    await selfTest();
    break;
  default:
    throw new Error(
      `未知命令：${command}。可用命令：setup、baseline、sync、recover、drain-events、retry-dead-letters、event、summary、status、self-test`,
    );
}
