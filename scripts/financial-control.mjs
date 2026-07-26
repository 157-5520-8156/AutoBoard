#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  combineFinancialAmounts,
  evaluateFinancialMatter,
  reconcileBidirectionalLinks,
} from "../lib/financial-rules.mjs";

const API = "https://open.feishu.cn";
const TIME_ZONE = "Asia/Shanghai";
const OPENCLAW_HOME =
  process.env.OPENCLAW_STATE_DIR ??
  path.join(process.env.OPENCLAW_HOME ?? os.homedir(), ".openclaw");
const CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ??
  path.join(OPENCLAW_HOME, "openclaw.json");
const WORKSPACE_DIR =
  process.env.AUTOBOARD_WORKSPACE_DIR ??
  path.join(OPENCLAW_HOME, "workspace");
const STATE_DIR =
  process.env.AUTOBOARD_STATE_DIR ??
  path.join(WORKSPACE_DIR, "state");
const STATE_PATH =
  process.env.AUTOBOARD_FINANCE_STATE_PATH ??
  path.join(STATE_DIR, "financial-control.json");
const EVENT_DIR =
  process.env.AUTOBOARD_FINANCE_EVENT_DIR ??
  path.join(STATE_DIR, "financial-events");
const SYNC_LOCK_PATH = path.join(
  STATE_DIR,
  "financial-control.sync-lock.sqlite",
);
const BASE_NAME = "经济事项与财务风控";
const BASE_TOKEN = process.env.AUTOBOARD_FINANCE_BASE_TOKEN ?? "";
const BASE_URL = process.env.AUTOBOARD_FINANCE_BASE_URL ?? "";
const TASK_BASE_TOKEN = process.env.AUTOBOARD_BASE_TOKEN ?? "";
const TASK_TABLE_ID = process.env.AUTOBOARD_TASK_TABLE_ID ?? "";
const COMMAND = process.argv[2] ?? "status";
const EVENT_FILE = process.argv
  .find((item) => item.startsWith("--event-file="))
  ?.slice(13);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`请求超过 ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const content = await response.text();
    return { response, content };
  } finally {
    clearTimeout(timer);
  }
}

const TABLES = {
  matters: {
    name: "经济事项主表",
    primary: "事项名称",
    defaultView: "事项总览",
  },
  budgets: {
    name: "预算及调整流水",
    primary: "预算记录标题",
    defaultView: "预算流水",
  },
  commitments: {
    name: "合同与承诺台账",
    primary: "合同/承诺名称",
    defaultView: "合同与承诺",
  },
  fulfillment: {
    name: "履约与验收记录",
    primary: "履约确认标题",
    defaultView: "履约与验收",
  },
  invoices: {
    name: "发票台账",
    primary: "发票标题",
    defaultView: "发票记录",
  },
  payments: {
    name: "付款流水",
    primary: "付款标题",
    defaultView: "付款记录",
  },
  alerts: {
    name: "风险与处置记录",
    primary: "预警标题",
    defaultView: "全部风险",
  },
  logs: {
    name: "财务变更日志",
    primary: "变更标题",
    defaultView: "全部变更",
  },
  policies: {
    name: "风控规则配置",
    primary: "规则名称",
    defaultView: "规则配置",
  },
};

const SOURCE_KEYS = [
  "matters",
  "budgets",
  "commitments",
  "fulfillment",
  "invoices",
  "payments",
  "alerts",
  "policies",
];

const text = (field_name) => ({ field_name, type: 1 });
const number = (field_name, ui_type = "Number") => ({
  field_name,
  type: 2,
  ui_type: ui_type === "Progress" ? "Number" : ui_type,
});
const date = (field_name, autoFill = false) => ({
  field_name,
  type: 5,
  property: {
    auto_fill: autoFill,
    date_formatter: "yyyy/MM/dd HH:mm",
  },
});
const select = (field_name, names) => ({
  field_name,
  type: 3,
  property: {
    options: names.map((name, index) => ({ name, color: index % 8 })),
  },
});
const checkbox = (field_name) => ({ field_name, type: 7 });
const attachment = (field_name) => ({ field_name, type: 17 });
const relation = (field_name, table_id, multiple = true) => ({
  field_name,
  type: 18,
  property: { table_id, multiple },
});
const createdTime = (field_name) => ({ field_name, type: 1001 });
const createdBy = (field_name) => ({ field_name, type: 1003 });

const commonChildFields = (matterTableId) => [
  text("事项编号"),
  relation("关联事项", matterTableId, false),
  text("经办部门"),
  text("经办人"),
  select("数据确认状态", ["AI草稿", "待人工复核", "人工已确认"]),
  text("来源消息ID"),
  text("备注"),
  attachment("附件"),
  createdTime("创建时间"),
  createdBy("创建人"),
];

function fieldDefinitions(tableIds) {
  const matters = [
    text("事项编号"),
    select("事项类型", ["采购", "投资", "费用", "工程", "其他"]),
    text("经办部门"),
    text("经办人"),
    text("责任人"),
    select("当前阶段", [
      "待录入",
      "待补资料",
      "规则校验",
      "待签字",
      "已签",
      "已退回",
      "已归档",
    ]),
    select("签字状态", ["未提交", "待签", "已签", "退回", "不适用"]),
    number("有效预算"),
    number("合同承诺额"),
    number("已确认义务"),
    number("已开票金额"),
    number("已付款金额"),
    number("应付款金额"),
    number("到期应付款"),
    number("预算承诺余额"),
    number("预算执行余额"),
    number("承诺占用率", "Progress"),
    number("执行占用率", "Progress"),
    select("最高风险", ["无", "黄色", "红色"]),
    select("签前建议", ["常规复核", "重点复核", "暂停签字并核查"]),
    text("资料缺失项"),
    text("关联任务编号"),
    text("关联日记编号"),
    text("来源消息ID"),
    text("备注"),
    attachment("事项附件"),
    date("最后计算时间"),
    createdTime("创建时间"),
    createdBy("创建人"),
  ];
  const budgets = [
    select("预算类型", ["初始预算", "追加预算", "调减预算", "预算取消"]),
    number("预算金额"),
    select("审批状态", ["待审批", "已批准", "已拒绝", "已撤销"]),
    text("批准文号"),
    text("批准人"),
    date("批准日期"),
    ...commonChildFields(tableIds.matters),
  ];
  const commitments = [
    text("合同/承诺编号"),
    select("承诺类型", ["采购合同", "投资协议", "订单", "合同外承诺", "其他"]),
    text("供应商/相对方"),
    number("当前有效承诺金额"),
    select("状态", ["草稿", "审批中", "生效", "履行中", "已完成", "已解除", "已作废"]),
    date("签订日期"),
    date("生效日期"),
    date("到期日期"),
    text("付款条件"),
    text("变更依据"),
    ...commonChildFields(tableIds.matters),
  ];
  const fulfillment = [
    select("记录类型", ["到货", "验收", "入库", "服务确认", "义务确认", "退货/冲销"]),
    number("确认义务金额"),
    select("确认状态", ["待确认", "已确认", "已拒绝", "已冲销"]),
    date("发生日期"),
    date("应付日期"),
    text("验收人"),
    text("验收结论"),
    text("对应合同/承诺编号"),
    ...commonChildFields(tableIds.matters),
  ];
  const invoices = [
    text("发票号码"),
    text("销售方"),
    number("价税合计"),
    select("发票状态", ["待核验", "有效", "已认证", "已入账", "红冲", "作废"]),
    date("开票日期"),
    text("对应合同/承诺编号"),
    text("查重标识"),
    ...commonChildFields(tableIds.matters),
  ];
  const payments = [
    text("付款流水号"),
    text("收款方"),
    text("收款账户尾号"),
    number("实付金额"),
    select("付款状态", ["待申请", "审批中", "已支付", "已退回", "已冲销"]),
    date("申请日期"),
    date("支付日期"),
    text("对应合同/承诺编号"),
    text("对应发票号码"),
    ...commonChildFields(tableIds.matters),
  ];
  const alerts = [
    text("预警标识"),
    text("事项编号"),
    relation("关联事项", tableIds.matters, false),
    text("规则代码"),
    select("风险等级", ["黄色", "红色"]),
    text("预警说明"),
    number("涉及金额"),
    select("处置状态", ["待处理", "处理中", "已解除", "接受风险"]),
    text("责任人"),
    text("处置意见"),
    number("累计触发次数"),
    date("首次触发时间"),
    date("最近触发时间"),
    date("解除时间"),
    text("解除依据"),
    attachment("处置附件"),
    text("整改任务编号"),
    createdTime("创建时间"),
    createdBy("创建人"),
  ];
  const logs = [
    date("记录时间", true),
    select("记录类型", ["自动变更", "重新计算", "手工备注", "风险处置"]),
    text("事项编号"),
    relation("关联事项", tableIds.matters, false),
    text("来源表"),
    text("来源记录ID"),
    text("变更字段"),
    text("变更前"),
    text("变更后"),
    text("变更标识"),
    text("记录人"),
    text("来源消息ID"),
    attachment("附件"),
    createdTime("创建时间"),
    createdBy("创建人"),
  ];
  const policies = [
    text("规则代码"),
    number("阈值"),
    checkbox("是否启用"),
    select("风险等级", ["黄色", "红色"]),
    select("配置状态", ["暂定", "正式"]),
    text("规则说明"),
    text("制度依据"),
    date("最后更新时间"),
  ];
  return {
    matters,
    budgets,
    commitments,
    fulfillment,
    invoices,
    payments,
    alerts,
    logs,
    policies,
  };
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, filePath);
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function loadCredentials() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  const feishu = config.channels?.feishu;
  if (!feishu?.appId || !feishu?.appSecret) {
    throw new Error("OpenClaw 配置中没有可用的飞书 appId/appSecret");
  }
  return { appId: feishu.appId, appSecret: feishu.appSecret };
}

let tenantToken;
async function authenticate() {
  if (tenantToken) return tenantToken;
  const { appId, appSecret } = await loadCredentials();
  const { response, content } = await fetchWithTimeout(
    `${API}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
    15_000,
  );
  const payload = content ? JSON.parse(content) : {};
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(
      `飞书认证失败：HTTP ${response.status}; code=${payload.code}; ${payload.msg}`,
    );
  }
  tenantToken = payload.tenant_access_token;
  return tenantToken;
}

async function request(apiPath, { method = "GET", body, retries = 5 } = {}) {
  const token = await authenticate();
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let response;
    let payload;
    try {
      const fetched = await fetchWithTimeout(
        `${API}${apiPath}`,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        30_000,
      );
      response = fetched.response;
      const content = fetched.content;
      try {
        payload = content ? JSON.parse(content) : {};
      } catch {
        payload = {
          code: "non-json-response",
          msg: content.slice(0, 200),
        };
      }
    } catch (error) {
      if (attempt < retries) {
        await sleep(600 * attempt);
        continue;
      }
      throw error;
    }
    if (response.ok && (payload.code === 0 || payload.code === 800070003)) {
      return payload.data ?? {};
    }
    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      [
        1254290,
        1254291,
        1254607,
        1254608,
        800030501,
        800004135,
      ].includes(payload.code);
    if (retryable && attempt < retries) {
      await sleep(700 * attempt);
      continue;
    }
    throw new Error(
      `${method} ${apiPath}: HTTP ${response.status}; code=${payload.code}; ${payload.msg}`,
    );
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

async function ensureBase() {
  const current = await readState();
  const configured = BASE_TOKEN || current?.baseToken;
  if (configured) {
    return {
      baseToken: configured,
      baseUrl:
        BASE_URL ||
        current?.baseUrl ||
        `https://feishu.cn/base/${configured}`,
      created: false,
    };
  }
  const data = await request("/open-apis/bitable/v1/apps", {
    method: "POST",
    body: { name: BASE_NAME },
  });
  const app = data.app ?? data;
  if (!app.app_token) throw new Error("飞书已返回成功，但缺少新财务多维表格 token");
  return {
    baseToken: app.app_token,
    baseUrl: app.url,
    created: true,
  };
}

async function ensureTables(baseToken, createdBase) {
  let tables = await listAll(
    `/open-apis/bitable/v1/apps/${baseToken}/tables`,
    100,
  );
  const tableIds = {};
  const pending = Object.entries(TABLES);
  if (createdBase && tables.length === 1) {
    const [firstKey, firstDefinition] = pending.shift();
    const defaultTable = tables[0];
    await request(
      `/open-apis/bitable/v1/apps/${baseToken}/tables/${defaultTable.table_id}`,
      { method: "PATCH", body: { name: firstDefinition.name } },
    );
    const fields = await listAll(
      `/open-apis/bitable/v1/apps/${baseToken}/tables/${defaultTable.table_id}/fields`,
      100,
    );
    const primary = fields.find((field) => field.is_primary);
    await request(
      `/open-apis/bitable/v1/apps/${baseToken}/tables/${defaultTable.table_id}/fields/${primary.field_id}`,
      {
        method: "PUT",
        body: { field_name: firstDefinition.primary, type: 1 },
      },
    );
    tableIds[firstKey] = defaultTable.table_id;
    await sleep(400);
    tables = await listAll(
      `/open-apis/bitable/v1/apps/${baseToken}/tables`,
      100,
    );
  }

  for (const [key, definition] of pending) {
    let table = tables.find((item) => item.name === definition.name);
    if (!table) {
      const data = await request(
        `/open-apis/bitable/v1/apps/${baseToken}/tables`,
        {
          method: "POST",
          body: {
            table: {
              name: definition.name,
              default_view_name: definition.defaultView,
              fields: [{ field_name: definition.primary, type: 1 }],
            },
          },
        },
      );
      table = data.table ?? data;
      tables.push(table);
      await sleep(500);
    }
    tableIds[key] = table.table_id;
  }
  return tableIds;
}

async function ensureFields(baseToken, tableIds) {
  const definitions = fieldDefinitions(tableIds);
  const schema = {};
  for (const [key, expectedFields] of Object.entries(definitions)) {
    const tableBase = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableIds[key]}`;
    let fields = await listAll(`${tableBase}/fields`, 100);
    const byName = new Map(fields.map((field) => [field.field_name, field]));
    for (const definition of expectedFields) {
      const existing = byName.get(definition.field_name);
      if (existing) {
        if (existing.type !== definition.type) {
          throw new Error(
            `${TABLES[key].name}.${definition.field_name} 类型不兼容：实际 ${existing.type}，预期 ${definition.type}`,
          );
        }
        continue;
      }
      try {
        await request(`${tableBase}/fields`, {
          method: "POST",
          body: definition,
        });
      } catch (error) {
        throw new Error(
          `创建字段失败：${TABLES[key].name}.${definition.field_name}（type=${definition.type}）`,
          { cause: error },
        );
      }
      await sleep(180);
    }
    fields = await listAll(`${tableBase}/fields`, 100);
    schema[key] = {
      count: fields.length,
      fields: Object.fromEntries(
        fields.map((field) => [field.field_name, field.field_id]),
      ),
    };
  }
  return schema;
}

async function ensureCrossModuleFields() {
  if (!TASK_BASE_TOKEN || !TASK_TABLE_ID) return { configured: false };
  const ensureTextField = async (tableId, fieldName) => {
    const tableBase = `/open-apis/bitable/v1/apps/${TASK_BASE_TOKEN}/tables/${tableId}`;
    const fields = await listAll(`${tableBase}/fields`, 100);
    if (fields.some((field) => field.field_name === fieldName)) return;
    await request(`${tableBase}/fields`, {
      method: "POST",
      body: text(fieldName),
    });
  };
  await ensureTextField(TASK_TABLE_ID, "关联财务事项编号");
  const taskTables = await listAll(
    `/open-apis/bitable/v1/apps/${TASK_BASE_TOKEN}/tables`,
    100,
  );
  const journal = taskTables.find(
    (table) => table.name === "任务工作日记",
  );
  if (journal) {
    await ensureTextField(journal.table_id, "关联财务事项编号");
    await ensureTextField(journal.table_id, "日记编号");
  }
  return {
    configured: true,
    taskTableId: TASK_TABLE_ID,
    journalTableId: journal?.table_id ?? null,
  };
}

function identifiers(value) {
  return [
    ...new Set(
      String(plain(value))
        .split(/[\s,，、;；]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

async function syncCrossModuleLinks(context, matters) {
  if (
    !TASK_BASE_TOKEN ||
    !TASK_TABLE_ID ||
    !context.crossModule?.journalTableId
  ) {
    return { configured: false, updated: 0 };
  }
  const journalTableId = context.crossModule.journalTableId;
  const [tasks, journals] = await Promise.all([
    listRecords(TASK_BASE_TOKEN, TASK_TABLE_ID),
    listRecords(TASK_BASE_TOKEN, journalTableId),
  ]);
  const mattersByNumber = new Map(
    matters.map((record) => [matterNumber(record), record]),
  );
  const tasksByNumber = new Map();
  for (const task of tasks) {
    const number = String(
      plain(task.fields?.["任务编号"]),
    ).trim();
    if (!number) continue;
    if (tasksByNumber.has(number)) {
      throw new Error(`任务编号重复：${number}`);
    }
    tasksByNumber.set(number, task);
  }
  const journalsByNumber = new Map();
  let updated = 0;
  for (const journal of journals) {
    let journalNumber = String(
      plain(journal.fields?.["日记编号"]),
    ).trim();
    if (!journalNumber) {
      journalNumber = `JRN-${journal.record_id}`;
      await request(
        `/open-apis/bitable/v1/apps/${TASK_BASE_TOKEN}/tables/${journalTableId}/records/${journal.record_id}`,
        { method: "PUT", body: { fields: { "日记编号": journalNumber } } },
      );
      journal.fields["日记编号"] = journalNumber;
      updated += 1;
    }
    if (journalsByNumber.has(journalNumber)) {
      throw new Error(`日记编号重复：${journalNumber}`);
    }
    journalsByNumber.set(journalNumber, journal);
  }

  const updateRecord = async (baseToken, tableId, record, fields) => {
    const changed = Object.entries(fields).some(
      ([name, value]) =>
        String(plain(record.fields?.[name])).trim() !== value,
    );
    if (!changed) return;
    await request(
      `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${record.record_id}`,
      { method: "PUT", body: { fields } },
    );
    Object.assign(record.fields, fields);
    updated += 1;
  };

  const pair = (left, right) => `${left}\u001f${right}`;
  const matterTaskPairs = new Set();
  const matterJournalPairs = new Set();
  const taskPairs = new Set();
  const journalPairs = new Set();
  for (const matter of matters) {
    const number = matterNumber(matter);
    for (const taskNumber of identifiers(
      matter.fields?.["关联任务编号"],
    )) {
      if (!tasksByNumber.has(taskNumber)) {
        throw new Error(
          `财务事项 ${number} 关联了不存在的任务编号：${taskNumber}`,
        );
      }
      matterTaskPairs.add(pair(number, taskNumber));
    }
    for (const journalNumber of identifiers(
      matter.fields?.["关联日记编号"],
    )) {
      if (!journalsByNumber.has(journalNumber)) {
        throw new Error(
          `财务事项 ${number} 关联了不存在的日记编号：${journalNumber}`,
        );
      }
      matterJournalPairs.add(pair(number, journalNumber));
    }
  }
  for (const task of tasks) {
    const taskNumber = String(
      plain(task.fields?.["任务编号"]),
    ).trim();
    const linkedFinanceNumbers = identifiers(
      task.fields?.["关联财务事项编号"],
    );
    if (linkedFinanceNumbers.length > 0 && !taskNumber) {
      throw new Error(
        `任务 ${task.record_id} 缺少任务编号，无法建立财务双向关联`,
      );
    }
    for (const number of linkedFinanceNumbers) {
      if (!mattersByNumber.has(number)) {
        throw new Error(
          `任务 ${taskNumber || task.record_id} 关联了不存在的财务事项：${number}`,
        );
      }
      taskPairs.add(pair(number, taskNumber));
    }
  }
  for (const journal of journals) {
    const journalNumber = String(
      plain(journal.fields?.["日记编号"]),
    ).trim();
    for (const number of identifiers(
      journal.fields?.["关联财务事项编号"],
    )) {
      if (!mattersByNumber.has(number)) {
        throw new Error(
          `日记 ${journalNumber} 关联了不存在的财务事项：${number}`,
        );
      }
      journalPairs.add(pair(number, journalNumber));
    }
  }

  const desiredTaskPairs = new Set(reconcileBidirectionalLinks(
    matterTaskPairs,
    taskPairs,
    context.crossModuleLinks?.tasks,
  ));
  const desiredJournalPairs = new Set(reconcileBidirectionalLinks(
    matterJournalPairs,
    journalPairs,
    context.crossModuleLinks?.journals,
  ));
  const valuesFor = (pairs, index, key) =>
    [...pairs]
      .map((item) => item.split("\u001f"))
      .filter((parts) => parts[index] === key)
      .map((parts) => parts[index === 0 ? 1 : 0])
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
      .join("、");

  for (const matter of matters) {
    const number = matterNumber(matter);
    await updateRecord(context.baseToken, context.tables.matters, matter, {
      "关联任务编号": valuesFor(desiredTaskPairs, 0, number),
      "关联日记编号": valuesFor(desiredJournalPairs, 0, number),
    });
  }
  for (const [taskNumber, task] of tasksByNumber) {
    await updateRecord(TASK_BASE_TOKEN, TASK_TABLE_ID, task, {
      "关联财务事项编号": valuesFor(
        desiredTaskPairs,
        1,
        taskNumber,
      ),
    });
  }
  for (const [journalNumber, journal] of journalsByNumber) {
    await updateRecord(TASK_BASE_TOKEN, journalTableId, journal, {
      "关联财务事项编号": valuesFor(
        desiredJournalPairs,
        1,
        journalNumber,
      ),
    });
  }
  return {
    configured: true,
    updated,
    links: {
      tasks: [...desiredTaskPairs].sort(),
      journals: [...desiredJournalPairs].sort(),
    },
  };
}

async function ensureViews(baseToken, tableIds, schema) {
  const views = {};
  async function listViews(tableId) {
    const data = await request(
      `/open-apis/base/v3/bases/${baseToken}/tables/${tableId}/views?limit=100`,
    );
    return data.views ?? [];
  }
  async function ensureView(tableKey, name, type = "grid") {
    const tableId = tableIds[tableKey];
    let view = (await listViews(tableId)).find((item) => item.name === name);
    if (!view) {
      const data = await request(
        `/open-apis/base/v3/bases/${baseToken}/tables/${tableId}/views`,
        { method: "POST", body: { name, type } },
      );
      view = data.view ?? data;
      await sleep(500);
    }
    views[`${tableKey}.${name}`] = view;
    return view;
  }
  async function configure(tableKey, view, segment, body) {
    await request(
      `/open-apis/base/v3/bases/${baseToken}/tables/${tableIds[tableKey]}/views/${view.id}/${segment}`,
      { method: "PUT", body },
    );
  }
  const field = (tableKey, name) => {
    const id = schema[tableKey].fields[name];
    if (!id) throw new Error(`${TABLES[tableKey].name} 缺少字段 ${name}`);
    return id;
  };

  const main = await ensureView("matters", "事项总览");
  const signature = await ensureView("matters", "签前审查看板", "kanban");
  const riskMatters = await ensureView("matters", "红黄风险事项");
  const alertBoard = await ensureView("alerts", "风险预警看板", "kanban");
  const activeAlerts = await ensureView("alerts", "待处理风险");
  const contractNodes = await ensureView("commitments", "合同到期与付款节点");
  const paymentView = await ensureView("payments", "付款时间线");
  const dailyLog = await ensureView("logs", "财务自动变更");

  const mainVisible = [
    "事项名称",
    "事项编号",
    "事项类型",
    "经办部门",
    "责任人",
    "当前阶段",
    "签字状态",
    "有效预算",
    "合同承诺额",
    "已确认义务",
    "已付款金额",
    "应付款金额",
    "到期应付款",
    "预算承诺余额",
    "预算执行余额",
    "承诺占用率",
    "执行占用率",
    "最高风险",
    "签前建议",
    "资料缺失项",
    "事项附件",
  ];
  for (const view of [main, signature, riskMatters]) {
    await configure("matters", view, "visible_fields", {
      visible_fields: mainVisible.map((name) => field("matters", name)),
    });
  }
  await configure("matters", signature, "group", {
    group_config: [{ field: field("matters", "当前阶段"), desc: false }],
  });
  await configure("matters", riskMatters, "filter", {
    logic: "or",
    conditions: [
      [field("matters", "最高风险"), "==", "红色"],
      [field("matters", "最高风险"), "==", "黄色"],
    ],
  });
  await configure("alerts", alertBoard, "group", {
    group_config: [{ field: field("alerts", "风险等级"), desc: true }],
  });
  for (const view of [alertBoard, activeAlerts]) {
    await configure("alerts", view, "filter", {
      logic: "or",
      conditions: [
        [field("alerts", "处置状态"), "==", "待处理"],
        [field("alerts", "处置状态"), "==", "处理中"],
      ],
    });
  }
  await configure("commitments", contractNodes, "sort", {
    sort_config: [{ field: field("commitments", "到期日期"), desc: false }],
  });
  await configure("payments", paymentView, "sort", {
    sort_config: [{ field: field("payments", "支付日期"), desc: true }],
  });
  await configure("logs", dailyLog, "sort", {
    sort_config: [{ field: field("logs", "记录时间"), desc: true }],
  });
  return views;
}

async function ensureDashboard(baseToken) {
  const root = `/open-apis/base/v3/bases/${baseToken}/dashboards`;
  const list = await request(`${root}?page_size=100`);
  let dashboard = (list.items ?? []).find(
    (item) => item.name === "财务风控总览",
  );
  if (!dashboard) {
    const data = await request(root, {
      method: "POST",
      body: { name: "财务风控总览" },
    });
    dashboard = data.dashboard ?? data;
  }
  const dashboardId = dashboard.dashboard_id ?? dashboard.id;
  const blocksRoot = `${root}/${dashboardId}/blocks`;
  const existing = await request(`${blocksRoot}?page_size=100`);
  const names = new Set(
    (existing.items ?? existing.blocks ?? []).map((block) => block.name),
  );
  const blocks = [
    {
      name: "有效预算合计",
      type: "statistics",
      data_config: {
        table_name: TABLES.matters.name,
        series: [{ field_name: "有效预算", rollup: "SUM" }],
      },
    },
    {
      name: "合同承诺合计",
      type: "statistics",
      data_config: {
        table_name: TABLES.matters.name,
        series: [{ field_name: "合同承诺额", rollup: "SUM" }],
      },
    },
    {
      name: "已确认义务合计",
      type: "statistics",
      data_config: {
        table_name: TABLES.matters.name,
        series: [{ field_name: "已确认义务", rollup: "SUM" }],
      },
    },
    {
      name: "已付款合计",
      type: "statistics",
      data_config: {
        table_name: TABLES.matters.name,
        series: [{ field_name: "已付款金额", rollup: "SUM" }],
      },
    },
    {
      name: "事项风险分布",
      type: "pie",
      data_config: {
        table_name: TABLES.matters.name,
        count_all: true,
        group_by: [{ field_name: "最高风险", mode: "integrated" }],
      },
    },
    {
      name: "各部门预算与付款",
      type: "column",
      data_config: {
        table_name: TABLES.matters.name,
        series: [
          { field_name: "有效预算", rollup: "SUM" },
          { field_name: "已付款金额", rollup: "SUM" },
        ],
        group_by: [{ field_name: "经办部门", mode: "integrated" }],
      },
    },
  ];
  for (const block of blocks) {
    if (names.has(block.name)) continue;
    await request(`${blocksRoot}?user_id_type=open_id`, {
      method: "POST",
      body: block,
    });
    await sleep(200);
  }
  await request(`${root}/${dashboardId}/arrange`, {
    method: "POST",
    body: {},
  });
  return { id: dashboardId, name: dashboard.name };
}

async function seedPolicies(baseToken, tableIds) {
  const tableBase = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableIds.policies}`;
  const records = await listAll(`${tableBase}/records`, 500);
  const existing = new Set(
    records.map((record) => record.fields?.["规则代码"]).filter(Boolean),
  );
  const defaults = [
    {
      "规则名称": "预算承诺占用黄色预警",
      "规则代码": "COMMITMENT_USAGE_WARNING_80",
      "阈值": 0.8,
      "是否启用": true,
      "风险等级": "黄色",
      "配置状态": "暂定",
      "规则说明": "合同及其他承诺达到有效预算80%时提醒；须按本单位制度确认。",
      "制度依据": "暂未提供单位内部制度，当前仅作管理提醒。",
      "最后更新时间": Date.now(),
    },
    {
      "规则名称": "预算承诺占用高位预警",
      "规则代码": "COMMITMENT_USAGE_WARNING_90",
      "阈值": 0.9,
      "是否启用": true,
      "风险等级": "黄色",
      "配置状态": "暂定",
      "规则说明": "合同及其他承诺达到有效预算90%时加强提醒；须按本单位制度确认。",
      "制度依据": "暂未提供单位内部制度，当前仅作管理提醒。",
      "最后更新时间": Date.now(),
    },
  ];
  for (const fields of defaults) {
    if (existing.has(fields["规则代码"])) continue;
    await request(`${tableBase}/records`, {
      method: "POST",
      body: { fields },
    });
  }
}

function plain(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "object" && item !== null
          ? item.text ?? item.name ?? item.record_id ?? ""
          : item,
      )
      .filter(Boolean)
      .join("、");
  }
  if (typeof value === "object" && value !== null) {
    return value.text ?? value.name ?? JSON.stringify(value);
  }
  return value ?? "";
}

function matterNumber(record) {
  return String(plain(record.fields?.["事项编号"])).trim();
}

function amount(record, name) {
  const value = Number(record.fields?.[name] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function recordsForMatter(records, matterRecord) {
  const number = matterNumber(matterRecord);
  return records.filter((record) => {
    const childNumber = String(
      plain(record.fields?.["事项编号"]),
    ).trim();
    const linked = record.fields?.["关联事项"];
    const linkedIds = Array.isArray(linked)
      ? linked
          .map((item) =>
            typeof item === "string" ? item : item?.record_id,
          )
          .filter(Boolean)
      : [];
    if (linkedIds.length > 0) {
      return (
        linkedIds.includes(matterRecord.record_id) &&
        (!childNumber || childNumber === number)
      );
    }
    return Boolean(number) && childNumber === number;
  });
}

function sum(records, name) {
  return combineFinancialAmounts(
    records.map((record) => ({ amount: record.fields?.[name] ?? 0 })),
  );
}

function dateValue(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function dateKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function trackedSnapshot(tableKey, record) {
  const ignored = new Set(["创建时间", "创建人", "最后计算时间"]);
  return Object.fromEntries(
    Object.entries(record.fields ?? {})
      .filter(([name]) => !ignored.has(name))
      .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
      .map(([name, value]) => [name, value]),
  );
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function loadContext() {
  const state = await readState();
  const baseToken = BASE_TOKEN || state?.baseToken;
  if (!baseToken || !state?.tables) {
    throw new Error("财务风控尚未 setup，缺少 Base 或表结构状态");
  }
  return { ...state, baseToken };
}

async function listRecords(baseToken, tableId) {
  return listAll(
    `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
    500,
  );
}

async function readPolicy(baseToken, tableIds) {
  const records = await listRecords(baseToken, tableIds.policies);
  const byCode = new Map(
    records.map((record) => [
      record.fields?.["规则代码"],
      record,
    ]),
  );
  const yellow = byCode.get("COMMITMENT_USAGE_WARNING_80");
  const orange = byCode.get("COMMITMENT_USAGE_WARNING_90");
  return {
    yellowThreshold:
      Number(yellow?.fields?.["阈值"]) || 0.8,
    orangeThreshold:
      Number(orange?.fields?.["阈值"]) || 0.9,
    yellowWarningEnabled:
      yellow?.fields?.["是否启用"] !== false,
    orangeWarningEnabled:
      orange?.fields?.["是否启用"] !== false,
  };
}

async function createChangeLogs(
  baseToken,
  tableIds,
  matters,
  recordsByKey,
  previousSnapshot,
) {
  const nextSnapshot = {};
  const matterByNumber = new Map(matters.map((item) => [matterNumber(item), item]));
  const logBase = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableIds.logs}`;
  const existingChangeIds = new Set(
    (recordsByKey.logs ?? [])
      .map((record) => record.fields?.["变更标识"])
      .filter(Boolean),
  );
  let changesLogged = 0;
  for (const tableKey of SOURCE_KEYS) {
    nextSnapshot[tableKey] = {};
    for (const record of recordsByKey[tableKey]) {
      const after = trackedSnapshot(tableKey, record);
      nextSnapshot[tableKey][record.record_id] = after;
      const before = previousSnapshot?.[tableKey]?.[record.record_id];
      if (before && JSON.stringify(before) === JSON.stringify(after)) continue;
      const names = [
        ...new Set([
          ...Object.keys(before ?? {}),
          ...Object.keys(after),
        ]),
      ]
        .filter(
          (name) =>
            JSON.stringify(before?.[name]) !==
            JSON.stringify(after[name]),
        );
      const number = String(
        plain(after["事项编号"] ?? before?.["事项编号"]),
      ).trim();
      const matter = matterByNumber.get(number);
      const changeId = `finance-change-${hash(
        JSON.stringify({ tableKey, recordId: record.record_id, before, after }),
      )}`;
      if (existingChangeIds.has(changeId)) continue;
      await request(`${logBase}/records`, {
        method: "POST",
        body: {
          fields: {
            "变更标题": `${TABLES[tableKey].name}${before ? "变更" : "新增"}：${number || record.record_id}`,
            "记录时间": Date.now(),
            "记录类型": "自动变更",
            "事项编号": number,
            ...(matter ? { "关联事项": [matter.record_id] } : {}),
            "来源表": TABLES[tableKey].name,
            "来源记录ID": record.record_id,
            "变更字段": names.join("、"),
            "变更前": names
              .map((name) => `${name}=${plain(before?.[name])}`)
              .join("\n"),
            "变更后": names
              .map((name) => `${name}=${plain(after[name])}`)
              .join("\n"),
            "变更标识": changeId,
            "记录人": "财务风控自动监测",
          },
        },
      });
      existingChangeIds.add(changeId);
      changesLogged += 1;
    }
    for (const [recordId, before] of Object.entries(
      previousSnapshot?.[tableKey] ?? {},
    )) {
      if (nextSnapshot[tableKey][recordId]) continue;
      const number = String(plain(before["事项编号"])).trim();
      const matter = matterByNumber.get(number);
      const changeId = `finance-change-${hash(
        JSON.stringify({ tableKey, recordId, before, after: null }),
      )}`;
      if (existingChangeIds.has(changeId)) continue;
      await request(`${logBase}/records`, {
        method: "POST",
        body: {
          fields: {
            "变更标题": `${TABLES[tableKey].name}移除：${number || recordId}`,
            "记录时间": Date.now(),
            "记录类型": "自动变更",
            "事项编号": number,
            ...(matter ? { "关联事项": [matter.record_id] } : {}),
            "来源表": TABLES[tableKey].name,
            "来源记录ID": recordId,
            "变更字段": "记录状态",
            "变更前": "存在",
            "变更后": "已移除",
            "变更标识": changeId,
            "记录人": "财务风控自动监测",
          },
        },
      });
      existingChangeIds.add(changeId);
      changesLogged += 1;
    }
  }
  return { nextSnapshot, changesLogged };
}

async function upsertAlerts(
  baseToken,
  tableIds,
  matter,
  evaluation,
  existingAlerts,
) {
  const tableBase = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableIds.alerts}`;
  const number = matterNumber(matter);
  const currentCodes = new Set(evaluation.alerts.map((item) => item.code));
  let alertsCreated = 0;
  let alertsUpdated = 0;

  for (const item of evaluation.alerts) {
    const key = `${number}:${item.code}`;
    const existing = existingAlerts.find(
      (record) => record.fields?.["预警标识"] === key,
    );
    const now = Date.now();
    const fields = {
      "预警标题": `${item.title}：${matter.fields?.["事项名称"] ?? number}`,
      "预警标识": key,
      "事项编号": number,
      "关联事项": [matter.record_id],
      "规则代码": item.code,
      "风险等级": item.severity,
      "预警说明": item.detail,
      "涉及金额": item.amount,
      "处置状态": ["处理中", "接受风险"].includes(
        existing?.fields?.["处置状态"],
      )
        ? existing.fields["处置状态"]
        : "待处理",
      "责任人": matter.fields?.["责任人"] ?? "",
      "累计触发次数": Math.max(
        1,
        Number(existing?.fields?.["累计触发次数"] ?? 0) +
          (existing?.fields?.["处置状态"] === "已解除" ? 1 : 0),
      ),
      "首次触发时间":
        existing?.fields?.["首次触发时间"] ?? now,
      "最近触发时间": now,
      "解除时间": null,
    };
    if (existing) {
      const materialNames = [
        "预警标题",
        "风险等级",
        "预警说明",
        "涉及金额",
        "处置状态",
        "责任人",
      ];
      const materiallyChanged =
        existing.fields?.["处置状态"] === "已解除" ||
        materialNames.some(
          (name) =>
            JSON.stringify(existing.fields?.[name] ?? null) !==
            JSON.stringify(fields[name] ?? null),
        );
      if (materiallyChanged) {
        await request(`${tableBase}/records/${existing.record_id}`, {
          method: "PUT",
          body: { fields },
        });
        alertsUpdated += 1;
      }
    } else {
      await request(`${tableBase}/records`, {
        method: "POST",
        body: { fields },
      });
      alertsCreated += 1;
    }
  }

  for (const existing of existingAlerts) {
    if (
      matterNumber({ fields: existing.fields }) !== number ||
      !["待处理", "处理中"].includes(existing.fields?.["处置状态"]) ||
      currentCodes.has(existing.fields?.["规则代码"])
    ) {
      continue;
    }
    await request(`${tableBase}/records/${existing.record_id}`, {
      method: "PUT",
      body: {
        fields: {
          "处置状态": "已解除",
          "解除时间": Date.now(),
          "解除依据": "确定性规则重新计算后，触发条件已不再成立；仍需人工复核原始资料。",
        },
      },
    });
    alertsUpdated += 1;
  }
  return { alertsCreated, alertsUpdated };
}

async function acquireSyncLock() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const database = new DatabaseSync(SYNC_LOCK_PATH);
  await fs.chmod(SYNC_LOCK_PATH, 0o600);
  try {
    database.exec("PRAGMA busy_timeout=30000; BEGIN IMMEDIATE;");
  } catch (error) {
    database.close();
    if (/locked|busy/i.test(error.message)) {
      throw new Error(
        "财务风控同步正在由另一进程执行，等待30秒后仍未取得锁",
        { cause: error },
      );
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      database.exec("COMMIT;");
    } finally {
      database.close();
    }
  };
}

async function syncUnlocked() {
  const context = await loadContext();
  const { baseToken, tables: tableIds } = context;
  const recordsByKey = Object.fromEntries(
    await Promise.all(
      Object.keys(TABLES).map(async (key) => [
        key,
        await listRecords(baseToken, tableIds[key]),
      ]),
    ),
  );
  const matters = recordsByKey.matters;
  const mattersById = new Map(
    matters.map((matter) => [matter.record_id, matter]),
  );
  const seenMatterNumbers = new Map();
  for (const matter of matters) {
    const number = matterNumber(matter);
    if (!number) {
      throw new Error(
        `经济事项 ${matter.record_id} 缺少事项编号，已停止计算以防金额串项`,
      );
    }
    if (seenMatterNumbers.has(number)) {
      throw new Error(
        `事项编号重复：${number}（${seenMatterNumbers.get(number)}、${matter.record_id}）`,
      );
    }
    seenMatterNumbers.set(number, matter.record_id);
  }
  const crossModule = await syncCrossModuleLinks(context, matters);
  for (const tableKey of [
    "budgets",
    "commitments",
    "fulfillment",
    "invoices",
    "payments",
  ]) {
    for (const record of recordsByKey[tableKey]) {
      const childNumber = String(
        plain(record.fields?.["事项编号"]),
      ).trim();
      const linked = record.fields?.["关联事项"];
      const linkedIds = Array.isArray(linked)
        ? linked
            .map((item) =>
              typeof item === "string" ? item : item?.record_id,
            )
            .filter(Boolean)
        : [];
      if (linkedIds.length > 1) {
        throw new Error(
          `${TABLES[tableKey].name} ${record.record_id} 关联了多个事项，已隔离并停止计算`,
        );
      }
      if (linkedIds.length === 1) {
        const linkedMatter = mattersById.get(linkedIds[0]);
        if (!linkedMatter) {
          throw new Error(
            `${TABLES[tableKey].name} ${record.record_id} 关联了不存在的事项`,
          );
        }
        if (
          childNumber &&
          childNumber !== matterNumber(linkedMatter)
        ) {
          throw new Error(
            `${TABLES[tableKey].name} ${record.record_id} 的事项编号与关联事项冲突`,
          );
        }
      } else if (!childNumber || !seenMatterNumbers.has(childNumber)) {
        throw new Error(
          `${TABLES[tableKey].name} ${record.record_id} 缺少有效事项归属`,
        );
      }
    }
  }
  const policy = await readPolicy(baseToken, tableIds);
  const existingAlerts = recordsByKey.alerts;
  const matterBase = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableIds.matters}`;
  let mattersUpdated = 0;
  let alertsCreated = 0;
  let alertsUpdated = 0;

  for (const matter of matters) {
    const budgets = recordsForMatter(recordsByKey.budgets, matter).filter(
      (record) =>
        record.fields?.["审批状态"] === "已批准" &&
        record.fields?.["数据确认状态"] === "人工已确认",
    );
    const commitments = recordsForMatter(
      recordsByKey.commitments,
      matter,
    ).filter((record) =>
      ["生效", "履行中", "已完成"].includes(record.fields?.["状态"]) &&
      record.fields?.["数据确认状态"] === "人工已确认",
    );
    const fulfillment = recordsForMatter(
      recordsByKey.fulfillment,
      matter,
    ).filter(
      (record) =>
        record.fields?.["确认状态"] === "已确认" &&
        record.fields?.["数据确认状态"] === "人工已确认",
    );
    const invoices = recordsForMatter(recordsByKey.invoices, matter).filter(
      (record) =>
        ["有效", "已认证", "已入账"].includes(record.fields?.["发票状态"]) &&
        record.fields?.["数据确认状态"] === "人工已确认",
    );
    const payments = recordsForMatter(recordsByKey.payments, matter).filter(
      (record) =>
        record.fields?.["付款状态"] === "已支付" &&
        record.fields?.["数据确认状态"] === "人工已确认",
    );
    const approvedBudget = combineFinancialAmounts(
      budgets.map((record) => ({
        amount: record.fields?.["预算金额"] ?? 0,
        direction: ["调减预算", "预算取消"].includes(
          record.fields?.["预算类型"],
        )
          ? -1
          : 1,
      })),
    );
    const committedAmount = sum(commitments, "当前有效承诺金额");
    const recognizedObligation = sum(fulfillment, "确认义务金额");
    const invoicedAmount = sum(invoices, "价税合计");
    const paidAmount = sum(payments, "实付金额");
    const dueObligation = sum(
      fulfillment.filter(
        (record) =>
          dateValue(record.fields?.["应付日期"]) > 0 &&
          dateValue(record.fields?.["应付日期"]) <= Date.now(),
      ),
      "确认义务金额",
    );
    const evaluation = evaluateFinancialMatter(
      {
        approvedBudget,
        committedAmount,
        recognizedObligation,
        invoicedAmount,
        paidAmount,
        dueObligation,
      },
      policy,
    );
    const computed = {
      "有效预算": evaluation.amounts.approvedBudget,
      "合同承诺额": evaluation.amounts.committedAmount,
      "已确认义务": evaluation.amounts.recognizedObligation,
      "已开票金额": evaluation.amounts.invoicedAmount,
      "已付款金额": evaluation.amounts.paidAmount,
      "应付款金额": evaluation.amounts.payableAmount,
      "到期应付款": evaluation.amounts.duePayableAmount,
      "预算承诺余额": evaluation.amounts.budgetCommitmentBalance,
      "预算执行余额": evaluation.amounts.budgetExecutionBalance,
      "承诺占用率": evaluation.ratios.commitmentRate ?? 0,
      "执行占用率": evaluation.ratios.executionRate ?? 0,
      "最高风险": evaluation.highestRisk,
      "签前建议": evaluation.signatureAdvice,
      "最后计算时间": Date.now(),
    };
    const changed = Object.entries(computed).some(
      ([name, value]) =>
        name !== "最后计算时间" &&
        JSON.stringify(matter.fields?.[name] ?? null) !==
          JSON.stringify(value),
    );
    if (changed) {
      await request(`${matterBase}/records/${matter.record_id}`, {
        method: "PUT",
        body: { fields: computed },
      });
      mattersUpdated += 1;
    }
    const alertResult = await upsertAlerts(
      baseToken,
      tableIds,
      matter,
      evaluation,
      existingAlerts,
    );
    alertsCreated += alertResult.alertsCreated;
    alertsUpdated += alertResult.alertsUpdated;
  }

  const logResult = await createChangeLogs(
    baseToken,
    tableIds,
    matters,
    recordsByKey,
    context.snapshot,
  );
  await atomicWriteJson(STATE_PATH, {
    ...context,
    schemaVersion: 1,
    lastSyncedAt: new Date().toISOString(),
    crossModuleLinks: crossModule.links ?? context.crossModuleLinks ?? {
      tasks: [],
      journals: [],
    },
    snapshot: logResult.nextSnapshot,
  });
  const result = {
    action: "sync",
    matters: matters.length,
    mattersUpdated,
    alertsCreated,
    alertsUpdated,
    changesLogged: logResult.changesLogged,
    policy,
    crossModule,
    syncedAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function sync() {
  const release = await acquireSyncLock();
  try {
    return await syncUnlocked();
  } finally {
    await release();
  }
}

async function baselineUnlocked() {
  const context = await loadContext();
  const snapshot = {};
  for (const key of SOURCE_KEYS) {
    snapshot[key] = Object.fromEntries(
      (await listRecords(context.baseToken, context.tables[key])).map(
        (record) => [
          record.record_id,
          trackedSnapshot(key, record),
        ],
      ),
    );
  }
  await atomicWriteJson(STATE_PATH, {
    ...context,
    snapshot,
    baselineAt: new Date().toISOString(),
  });
  console.log(
    JSON.stringify({
      action: "baseline",
      records: Object.values(snapshot).reduce(
        (total, records) => total + Object.keys(records).length,
        0,
      ),
      statePath: STATE_PATH,
    }),
  );
}

async function baseline() {
  const release = await acquireSyncLock();
  try {
    return await baselineUnlocked();
  } finally {
    await release();
  }
}

async function processEvent() {
  if (!EVENT_FILE) throw new Error("event 命令缺少 --event-file");
  const context = await loadContext();
  const event = JSON.parse(await fs.readFile(EVENT_FILE, "utf8"));
  const sourceIds = new Set(
    SOURCE_KEYS.map((key) => context.tables[key]),
  );
  if (
    event.file_token !== context.baseToken ||
    !sourceIds.has(event.table_id)
  ) {
    console.log(
      JSON.stringify({
        action: "event",
        ignored: true,
        reason: "different-base-or-output-table",
      }),
    );
    return;
  }
  const result = await sync();
  console.log(
    JSON.stringify({
      action: "event",
      eventId: event.event_id ?? event.uuid ?? null,
      sync: result,
    }),
  );
}

async function drainEvents() {
  await fs.mkdir(EVENT_DIR, { recursive: true });
  const entries = (await fs.readdir(EVENT_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const result = await sync();
  for (const name of entries) {
    await fs.unlink(path.join(EVENT_DIR, name));
  }
  console.log(
    JSON.stringify({
      action: "drain-events",
      processed: entries.length,
      sync: result,
    }),
  );
}

function replaceMarkedSection(content, marker, section) {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const block = `${start}\n${section.trim()}\n${end}`;
  const expression = new RegExp(
    `${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  return expression.test(content)
    ? content.replace(expression, block)
    : `${content.trimEnd()}\n\n${block}\n`;
}

async function configureWorkspace() {
  const context = await loadContext();
  const boardView =
    context.views?.["matters.签前审查看板"]?.id ?? "";
  const boardUrl = `${context.baseUrl}?table=${context.tables.matters}${
    boardView ? `&view=${boardView}` : ""
  }`;
  const toolsPath = path.join(WORKSPACE_DIR, "TOOLS.md");
  const agentsPath = path.join(WORKSPACE_DIR, "AGENTS.md");
  const tools = await fs.readFile(toolsPath, "utf8");
  const agents = await fs.readFile(agentsPath, "utf8");
  const toolsSection = `
## 飞书财务风控

- 名称：${BASE_NAME}
- URL：${context.baseUrl}
- app_token：\`${context.baseToken}\`
- 经济事项主表 table_id：\`${context.tables.matters}\`
- 预算及调整流水 table_id：\`${context.tables.budgets}\`
- 合同与承诺台账 table_id：\`${context.tables.commitments}\`
- 履约与验收记录 table_id：\`${context.tables.fulfillment}\`
- 发票台账 table_id：\`${context.tables.invoices}\`
- 付款流水 table_id：\`${context.tables.payments}\`
- 风险与处置记录 table_id：\`${context.tables.alerts}\`
- 财务变更日志 table_id：\`${context.tables.logs}\`
- 风控规则配置 table_id：\`${context.tables.policies}\`
- 签前审查看板：${boardUrl}
- 财务汇总、预警和签前建议由 \`/opt/autoboard/scripts/financial-control.mjs sync\` 确定性计算；不得由模型心算后直接覆盖。
`;
  const agentsSection = `
## 经济事项与财务风控

- 财务模块是签前核验、预算占用、合同履约、付款风险和留痕工具，不是会计账簿，也不得向用户保证“签字无责任”。
- 用户提供采购、投资、合同、验收、发票、付款或欠款信息时，先区分：有效预算、合同承诺、已确认义务、开票、已付款、到期应付款。不得把“已花”和“还欠”在口径不明时直接相加。
- 新业务先在“经济事项主表”建立唯一事项，编号使用 \`FIN-YYYYMMDD-NNN\`；预算、承诺、履约、发票、付款必须分别写入对应流水表，并同时填写“事项编号”和“关联事项”。
- AI从笔记或附件提取的金额、合同编号、账户、发票号和日期均为待核对草稿，所有AI新建流水必须写 \`数据确认状态=AI草稿\`。只有明确获授权的人在表内改为 \`人工已确认\` 后，该行才参与预算、义务、付款和风险计算。模型不得自行把草稿改为人工已确认。
- 模糊字段不得猜测；在备注中标明待确认。
- 汇总字段、风险等级和签前建议只能由财务风控脚本计算。录入或修改流水后由飞书事件和15分钟补偿任务自动同步；模型不得通过系统命令绕过受控工具，也不要直接手改主表汇总金额。
- “红色”表示暂停签字并核查，“黄色”表示重点复核，“无”仍需常规人工复核。预警解除必须保留解除依据和处置记录，不能删除原风险。
- 风控规则配置中标记“暂定”的80%和90%阈值只是管理提醒。未取得单位制度前，不得称为法定或正式审批标准。
- 财务信息默认仅向明确获授权人员提供。不得在群聊中披露合同金额、供应商、账户、发票和付款详情，也不得仅因用户已经配对就扩大财务表权限。
- 财务快捷卡片和财务明细只提供给 \`AUTOBOARD_FINANCE_RECIPIENT_ALLOWLIST\` 中的用户或会话。其他用户即使已配对，也只能继续使用任务和日记功能。
- 财务事项关联整改任务或日记时，除填写财务主表的“关联任务编号/关联日记编号”外，还要回写任务或日记中的“关联财务事项编号”，避免形成单向文本链接。
- 用户只发概括性描述但金额口径矛盾时，可以先建事项并标记“待补资料”，不得制造一套看似精确的账。
`;
  await fs.writeFile(
    toolsPath,
    replaceMarkedSection(tools, "AUTOBOARD_FINANCE_TOOLS", toolsSection),
    "utf8",
  );
  await fs.writeFile(
    agentsPath,
    replaceMarkedSection(agents, "AUTOBOARD_FINANCE_AGENTS", agentsSection),
    "utf8",
  );
  console.log(
    JSON.stringify({ action: "configure-workspace", boardUrl }, null, 2),
  );
}

async function setup() {
  const previousState = await readState();
  const base = await ensureBase();
  const tables = await ensureTables(base.baseToken, base.created);
  const schema = await ensureFields(base.baseToken, tables);
  const crossModule = await ensureCrossModuleFields();
  const views = await ensureViews(base.baseToken, tables, schema);
  const dashboard = await ensureDashboard(base.baseToken);
  await seedPolicies(base.baseToken, tables);
  const state = {
    schemaVersion: 1,
    baseName: BASE_NAME,
    baseToken: base.baseToken,
    baseUrl: base.baseUrl,
    tables,
    views,
    dashboard,
    crossModule,
    crossModuleLinks: previousState?.crossModuleLinks ?? {
      tasks: [],
      journals: [],
    },
    setupAt: new Date().toISOString(),
    baselineAt: previousState?.baselineAt ?? null,
    lastSyncedAt: previousState?.lastSyncedAt ?? null,
    snapshot: previousState?.snapshot ?? null,
  };
  await atomicWriteJson(STATE_PATH, state);
  if (!state.snapshot) await baseline();
  const boardView = views["matters.签前审查看板"];
  console.log(
    JSON.stringify(
      {
        action: "setup",
        createdBase: base.created,
        baseName: BASE_NAME,
        baseUrl: base.baseUrl,
        baseToken: base.baseToken,
        tables,
        boardUrl: `${base.baseUrl}?table=${tables.matters}&view=${boardView.id}`,
        dashboard,
        crossModule,
      },
      null,
      2,
    ),
  );
}

async function status() {
  const context = await loadContext();
  const tableStatus = {};
  let matterFields = [];
  for (const [key, definition] of Object.entries(TABLES)) {
    const tableId = context.tables[key];
    const [fields, records] = await Promise.all([
      listAll(
        `/open-apis/bitable/v1/apps/${context.baseToken}/tables/${tableId}/fields`,
        100,
      ),
      listRecords(context.baseToken, tableId),
    ]);
    const expected = fieldDefinitions(context.tables)[key];
    if (key === "matters") matterFields = fields;
    const actualByName = new Map(
      fields.map((field) => [field.field_name, field]),
    );
    const missing = expected
      .filter((field) => !actualByName.has(field.field_name))
      .map((field) => field.field_name);
    const incompatible = expected
      .filter((field) => {
        const actual = actualByName.get(field.field_name);
        return actual && actual.type !== field.type;
      })
      .map((field) => field.field_name);
    tableStatus[key] = {
      id: tableId,
      name: definition.name,
      fields: fields.length,
      records: records.length,
      missing,
      incompatible,
    };
  }
  const matterViewRoot = `/open-apis/base/v3/bases/${context.baseToken}/tables/${context.tables.matters}/views`;
  const liveViews = (await request(`${matterViewRoot}?limit=100`)).views ?? [];
  const boardView = liveViews.find(
    (view) => view.name === "签前审查看板",
  );
  let boardGroupFields = [];
  if (boardView) {
    const groupData = await request(
      `${matterViewRoot}/${boardView.id}/group`,
    );
    const groups = Array.isArray(groupData)
      ? groupData
      : groupData.group_config ?? [];
    const fieldsById = new Map(
      matterFields.map((field) => [field.field_id, field.field_name]),
    );
    boardGroupFields = groups
      .map((group) => fieldsById.get(group.field) ?? group.field)
      .filter(Boolean);
  }
  const dashboardRoot = `/open-apis/base/v3/bases/${context.baseToken}/dashboards`;
  const dashboards = (await request(`${dashboardRoot}?page_size=100`)).items ?? [];
  const dashboard = dashboards.find(
    (item) => item.name === "财务风控总览",
  );
  let dashboardBlocks = [];
  if (dashboard) {
    const dashboardId = dashboard.dashboard_id ?? dashboard.id;
    const blockData = await request(
      `${dashboardRoot}/${dashboardId}/blocks?page_size=100`,
    );
    dashboardBlocks = (blockData.items ?? blockData.blocks ?? []).map(
      (block) => block.name,
    );
  }
  let crossModule = { configured: false };
  if (TASK_BASE_TOKEN && TASK_TABLE_ID) {
    const taskFields = await listAll(
      `/open-apis/bitable/v1/apps/${TASK_BASE_TOKEN}/tables/${TASK_TABLE_ID}/fields`,
      100,
    );
    const taskTables = await listAll(
      `/open-apis/bitable/v1/apps/${TASK_BASE_TOKEN}/tables`,
      100,
    );
    const journal = taskTables.find(
      (table) => table.name === "任务工作日记",
    );
    const journalFields = journal
      ? await listAll(
          `/open-apis/bitable/v1/apps/${TASK_BASE_TOKEN}/tables/${journal.table_id}/fields`,
          100,
        )
      : [];
    crossModule = {
      configured: true,
      taskField: taskFields.some(
        (field) => field.field_name === "关联财务事项编号",
      ),
      journalField: journalFields.some(
        (field) => field.field_name === "关联财务事项编号",
      ),
      journalIdField: journalFields.some(
        (field) => field.field_name === "日记编号",
      ),
    };
  }
  const result = {
    action: "status",
    baseName: context.baseName,
    baseUrl: context.baseUrl,
    tables: tableStatus,
    boardView: boardView
      ? {
          id: boardView.id,
          name: boardView.name,
          type: boardView.type,
          groupFields: boardGroupFields,
        }
      : null,
    dashboard: dashboard
      ? {
          id: dashboard.dashboard_id ?? dashboard.id,
          name: dashboard.name,
          blocks: dashboardBlocks,
        }
      : null,
    crossModule,
    snapshotAt: context.lastSyncedAt ?? context.baselineAt ?? null,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function selfTest() {
  const caseA = evaluateFinancialMatter({
    approvedBudget: 1_000_000,
    committedAmount: 1_200_000,
    recognizedObligation: 1_200_000,
    paidAmount: 700_000,
    dueObligation: 1_200_000,
  });
  const caseB = evaluateFinancialMatter({
    approvedBudget: 1_000_000,
    committedAmount: 1_080_000,
    recognizedObligation: 1_080_000,
    paidAmount: 800_000,
    dueObligation: 1_080_000,
  });
  if (
    caseA.amounts.budgetExecutionBalance !== -200_000 ||
    caseB.amounts.budgetExecutionBalance !== -80_000
  ) {
    throw new Error("金额口径自检失败");
  }
  const current = await status();
  const broken = Object.values(current.tables).filter(
    (table) => table.missing.length || table.incompatible.length,
  );
  if (broken.length) {
    throw new Error(
      `财务表结构自检失败：${broken.map((table) => table.name).join("、")}`,
    );
  }
  if (
    !current.boardView ||
    !current.boardView.groupFields.includes("当前阶段")
  ) {
    throw new Error("签前审查看板不存在或未按当前阶段分组");
  }
  if (
    !current.dashboard ||
    current.dashboard.blocks.length < 6
  ) {
    throw new Error("财务风控总览不存在或图表不完整");
  }
  if (
    !current.crossModule.configured ||
    !current.crossModule.taskField ||
    !current.crossModule.journalField ||
    !current.crossModule.journalIdField
  ) {
    throw new Error(
      "跨模块关联字段不完整：任务主表和任务工作日记都必须包含关联财务事项编号",
    );
  }
  console.log(
    JSON.stringify({
      action: "self-test",
      passed: true,
      checked: [
        "整数分金额计算",
        "两种欠款口径",
        "九张表字段完整性",
        "签前审查看板",
        "财务风控仪表盘",
        "任务与日记双向关联字段",
      ],
    }),
  );
}

async function purgeTestRecords(
  baseToken,
  tables,
  predicate = (number) => number.startsWith("TEST-FIN-"),
) {
  const errors = [];
  const tableKeys = Object.keys(TABLES).filter(
    (key) => key !== "policies",
  );
  for (let pass = 1; pass <= 3; pass += 1) {
    let removedThisPass = 0;
    for (const tableKey of tableKeys) {
      let records;
      try {
        records = await listRecords(baseToken, tables[tableKey]);
      } catch (error) {
        errors.push(
          `${TABLES[tableKey].name}:第${pass}轮查询:${error.message}`,
        );
        continue;
      }
      for (const record of records) {
        if (!predicate(matterNumber(record))) continue;
        try {
          await request(
            `/open-apis/bitable/v1/apps/${baseToken}/tables/${tables[tableKey]}/records/${record.record_id}`,
            { method: "DELETE" },
          );
          removedThisPass += 1;
        } catch (error) {
          errors.push(
            `${TABLES[tableKey].name}:${record.record_id}:第${pass}轮删除:${error.message}`,
          );
        }
      }
    }
    if (removedThisPass === 0 && pass > 1) break;
  }

  const residual = [];
  for (const tableKey of tableKeys) {
    let records;
    try {
      records = await listRecords(baseToken, tables[tableKey]);
    } catch (error) {
      errors.push(`${TABLES[tableKey].name}:残留查询:${error.message}`);
      continue;
    }
    for (const record of records) {
      if (predicate(matterNumber(record))) {
        residual.push(`${TABLES[tableKey].name}:${record.record_id}`);
      }
    }
  }
  return { errors, residual };
}

async function liveSelfTestUnlocked() {
  const context = await loadContext();
  const { baseToken, tables } = context;
  const suffix = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const number = `TEST-FIN-${suffix}`;
  const create = async (tableKey, fields) => {
    const data = await request(
      `/open-apis/bitable/v1/apps/${baseToken}/tables/${tables[tableKey]}/records`,
      { method: "POST", body: { fields } },
    );
    const record = data.record ?? data;
    return record;
  };
  let matter;
  let successResult;
  try {
    console.error(
      JSON.stringify({ action: "live-self-test-progress", phase: "create" }),
    );
    matter = await create("matters", {
      "事项名称": `端到端临时测试 ${suffix}`,
      "事项编号": number,
      "事项类型": "采购",
      "经办部门": "自动测试",
      "责任人": "自动测试",
      "当前阶段": "规则校验",
      "签字状态": "待签",
      "备注": "自动测试记录；测试结束后由脚本删除。",
    });
    const common = {
      "事项编号": number,
      "关联事项": [matter.record_id],
      "经办部门": "自动测试",
      "经办人": "自动测试",
      "数据确认状态": "人工已确认",
    };
    await create("budgets", {
      "预算记录标题": `临时预算 ${suffix}`,
      "预算类型": "初始预算",
      "预算金额": 1_000_000,
      "审批状态": "已批准",
      ...common,
    });
    await create("budgets", {
      "预算记录标题": `AI草稿预算（不得计入） ${suffix}`,
      "预算类型": "追加预算",
      "预算金额": 9_000_000,
      "审批状态": "已批准",
      ...common,
      "数据确认状态": "AI草稿",
    });
    await create("commitments", {
      "合同/承诺名称": `临时合同 ${suffix}`,
      "合同/承诺编号": `TEST-CONTRACT-${suffix}`,
      "承诺类型": "采购合同",
      "当前有效承诺金额": 1_200_000,
      "状态": "生效",
      ...common,
    });
    await create("fulfillment", {
      "履约确认标题": `临时义务确认 ${suffix}`,
      "记录类型": "义务确认",
      "确认义务金额": 1_200_000,
      "确认状态": "已确认",
      "发生日期": Date.now(),
      "应付日期": Date.now() - 86_400_000,
      ...common,
    });
    await create("invoices", {
      "发票标题": `临时发票 ${suffix}`,
      "发票号码": `TEST-INVOICE-${suffix}`,
      "价税合计": 1_200_000,
      "发票状态": "有效",
      ...common,
    });
    await create("payments", {
      "付款标题": `临时付款 ${suffix}`,
      "付款流水号": `TEST-PAYMENT-${suffix}`,
      "实付金额": 700_000,
      "付款状态": "已支付",
      "支付日期": Date.now(),
      ...common,
    });

    console.error(
      JSON.stringify({ action: "live-self-test-progress", phase: "sync" }),
    );
    await syncUnlocked();
    console.error(
      JSON.stringify({ action: "live-self-test-progress", phase: "verify" }),
    );
    const [matters, alerts, logs] = await Promise.all([
      listRecords(baseToken, tables.matters),
      listRecords(baseToken, tables.alerts),
      listRecords(baseToken, tables.logs),
    ]);
    const actual = matters.find(
      (record) => matterNumber(record) === number,
    );
    if (
      amount(actual, "有效预算") !== 1_000_000 ||
      amount(actual, "应付款金额") !== 500_000 ||
      amount(actual, "预算执行余额") !== -200_000 ||
      actual.fields?.["最高风险"] !== "红色" ||
      actual.fields?.["签前建议"] !== "暂停签字并核查"
    ) {
      throw new Error("真实飞书表汇总结果与规则测试不一致");
    }
    const obligationAlert = alerts.find(
      (record) =>
        record.fields?.["事项编号"] === number &&
        record.fields?.["规则代码"] === "BUDGET_OBLIGATION_EXCEEDED",
    );
    if (
      !obligationAlert ||
      amount(obligationAlert, "涉及金额") !== 200_000
    ) {
      throw new Error("真实飞书表没有生成正确的超预算预警");
    }
    const testLogs = logs.filter(
      (record) => record.fields?.["事项编号"] === number,
    );
    if (testLogs.length < 6) {
      throw new Error(
        `真实飞书表自动留痕不完整：预期至少6条，实际${testLogs.length}条`,
      );
    }
    successResult = {
      action: "live-self-test",
      passed: true,
      checked: [
        "九表关联写入",
        "AI草稿不进入财务汇总",
        "100万预算与120万义务汇总",
        "50万应付款",
        "20万超预算红色预警",
        "签前暂停建议",
        "新增流水自动留痕",
        "测试数据零残留复查",
      ],
    };
  } finally {
    console.error(
      JSON.stringify({ action: "live-self-test-progress", phase: "cleanup" }),
    );
    const cleanup = await purgeTestRecords(
      baseToken,
      tables,
      (candidate) => candidate === number,
    );
    try {
      await baselineUnlocked();
    } catch (error) {
      cleanup.errors.push(`重建基线:${error.message}`);
    }
    if (cleanup.errors.length || cleanup.residual.length) {
      throw new Error(
        `端到端测试数据清理失败；错误=${cleanup.errors.join("|") || "无"}；残留=${cleanup.residual.join("|") || "无"}`,
      );
    }
  }
  console.error(
    JSON.stringify({ action: "live-self-test-progress", phase: "complete" }),
  );
  console.log(JSON.stringify(successResult));
}

async function liveSelfTest() {
  const release = await acquireSyncLock();
  try {
    return await liveSelfTestUnlocked();
  } finally {
    await release();
  }
}

async function cleanupLiveTestsUnlocked() {
  const context = await loadContext();
  const cleanup = await purgeTestRecords(
    context.baseToken,
    context.tables,
  );
  try {
    await baselineUnlocked();
  } catch (error) {
    cleanup.errors.push(`重建基线:${error.message}`);
  }
  if (cleanup.errors.length || cleanup.residual.length) {
    throw new Error(
      `测试数据清理失败；错误=${cleanup.errors.join("|") || "无"}；残留=${cleanup.residual.join("|") || "无"}`,
    );
  }
  console.log(
    JSON.stringify({ action: "cleanup-live-tests", passed: true }, null, 2),
  );
}

async function cleanupLiveTests() {
  const release = await acquireSyncLock();
  try {
    return await cleanupLiveTestsUnlocked();
  } finally {
    await release();
  }
}

switch (COMMAND) {
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
    await drainEvents();
    break;
  case "event":
    await processEvent();
    break;
  case "drain-events":
    await drainEvents();
    break;
  case "configure-workspace":
    await configureWorkspace();
    break;
  case "status":
    await status();
    break;
  case "self-test":
    await selfTest();
    break;
  case "live-self-test":
    await liveSelfTest();
    break;
  case "cleanup-live-tests":
    await cleanupLiveTests();
    break;
  default:
    throw new Error(
      `未知命令：${COMMAND}。可用命令：setup、baseline、sync、recover、event、drain-events、configure-workspace、status、self-test、live-self-test、cleanup-live-tests`,
    );
}
