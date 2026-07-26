import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TASK_BOARD_URL =
  process.env.AUTOBOARD_TASK_BOARD_URL ??
  "https://example.invalid/configure-AUTOBOARD_TASK_BOARD_URL";
const DIARY_BOARD_URL =
  process.env.AUTOBOARD_DIARY_BOARD_URL ??
  "https://example.invalid/configure-AUTOBOARD_DIARY_BOARD_URL";
const FINANCE_BOARD_URL =
  process.env.AUTOBOARD_FINANCE_BOARD_URL ??
  "https://example.invalid/configure-AUTOBOARD_FINANCE_BOARD_URL";
const FINANCE_BASE_TOKEN =
  process.env.AUTOBOARD_FINANCE_BASE_TOKEN ?? "";
const FINANCE_RECIPIENT_ALLOWLIST = new Set(
  String(process.env.AUTOBOARD_FINANCE_RECIPIENT_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const OPENCLAW_HOME =
  process.env.OPENCLAW_STATE_DIR ??
  path.join(process.env.OPENCLAW_HOME ?? os.homedir(), ".openclaw");
const CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ??
  path.join(OPENCLAW_HOME, "openclaw.json");
const LOG_PATH = path.join(
  OPENCLAW_HOME,
  "logs",
  "board-quick-links.log",
);
const DEDUPE_TTL_MS = 10 * 60 * 1000;

let cachedCredentials;
let cachedToken;
const completedRuns = new Map();

async function appendLog(message) {
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
    await fs.appendFile(
      LOG_PATH,
      `${new Date().toISOString()} ${message}\n`,
      "utf8",
    );
  } catch {
    // Shortcut delivery must not affect the agent's normal reply.
  }
}

async function loadCredentials() {
  if (cachedCredentials) return cachedCredentials;
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  const feishu = config.channels?.feishu;
  if (!feishu?.appId || !feishu?.appSecret) {
    throw new Error("Feishu appId/appSecret are not configured");
  }
  cachedCredentials = {
    appId: feishu.appId,
    appSecret: feishu.appSecret,
  };
  return cachedCredentials;
}

async function getTenantAccessToken(fetchImpl) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }

  const { appId, appSecret } = await loadCredentials();
  const response = await fetchImpl(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const result = await response.json();
  if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
    throw new Error(
      `Feishu token request failed: HTTP ${response.status}, code ${result.code ?? "unknown"}`,
    );
  }

  cachedToken = {
    value: result.tenant_access_token,
    expiresAt: now + Math.max(60, Number(result.expire ?? 7200) - 120) * 1000,
  };
  return cachedToken.value;
}

function buildCard({ title, description, buttonText, url, template }) {
  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: {
      title: { tag: "plain_text", content: title },
      template,
    },
    body: {
      elements: [
        { tag: "markdown", content: description },
        {
          tag: "button",
          text: { tag: "plain_text", content: buttonText },
          type: "primary",
          behaviors: [{ type: "open_url", default_url: url }],
        },
      ],
    },
  };
}

export function buildCards({ includeFinance = true } = {}) {
  const cards = [
    buildCard({
      title: "部长协作大看板",
      description: "查看和拖动任务卡片；主表、负责人视图与任务状态保持联动。",
      buttonText: "打开任务协作看板",
      url: TASK_BOARD_URL,
      template: "blue",
    }),
    buildCard({
      title: "日记按天看板",
      description: "按日期查看任务变更、进展记录、备注和事件。",
      buttonText: "打开日记按天看板",
      url: DIARY_BOARD_URL,
      template: "turquoise",
    }),
  ];
  if (includeFinance) {
    cards.push(buildCard({
      title: "财务签前审查看板",
      description: "查看预算、合同承诺、确认义务、付款与红黄风险；系统提示不替代人工签字复核。",
      buttonText: "打开财务风控看板",
      url: FINANCE_BOARD_URL,
      template: "orange",
    }));
  }
  return cards;
}

export function resolveRecipient(context = {}) {
  const chatId = String(
    context.chatId ??
      context.channelContext?.chat?.id ??
      (String(context.channelId ?? "").startsWith("oc_")
        ? context.channelId
        : ""),
  ).trim();
  if (chatId.startsWith("oc_")) {
    return { id: chatId, type: "chat_id" };
  }

  const senderId = String(
    context.senderId ??
      context.channelContext?.sender?.id ??
      (String(context.channelId ?? "").startsWith("ou_")
        ? context.channelId
        : ""),
  ).trim();
  if (senderId.startsWith("ou_")) {
    return { id: senderId, type: "open_id" };
  }
  return null;
}

export function resolveSessionRecipient(context = {}) {
  const sessionKey = String(
    context.sessionKey ?? context.sessionId ?? "",
  );
  if (!sessionKey.includes(":feishu:")) return null;
  const match = sessionKey.match(/:(ou_[A-Za-z0-9]+|oc_[A-Za-z0-9]+)$/);
  return match?.[1] ?? null;
}

export function createBeforeToolCallHandler(options = {}) {
  const financeRecipientIds =
    options.financeRecipientIds ?? FINANCE_RECIPIENT_ALLOWLIST;
  const financeBaseToken =
    options.financeBaseToken ?? FINANCE_BASE_TOKEN;
  const protectedSystemTools = new Set([
    "exec",
    "read",
    "write",
    "edit",
    "apply_patch",
  ]);
  return async function beforeToolCall(event = {}, context = {}) {
    const recipientId = resolveSessionRecipient(context);
    const authorized =
      Boolean(recipientId) && financeRecipientIds.has(recipientId);
    const toolName = String(event.toolName ?? "");
    const params = event.params ?? {};

    if (protectedSystemTools.has(toolName)) {
      return {
        block: true,
        blockReason:
          "AutoBoard 对话不得直接调用系统或文件工具；请使用受控的飞书看板工具。",
      };
    }

    const targetsFinance =
      Boolean(financeBaseToken) &&
      (
        params.app_token === financeBaseToken ||
        JSON.stringify(params).includes(financeBaseToken)
      );
    if (!targetsFinance) return;
    if (!authorized) {
      return {
        block: true,
        blockReason:
          "当前飞书用户未被列入财务模块授权白名单。",
      };
    }
    if (
      toolName.startsWith("feishu_bitable_") &&
      /人工已确认/.test(JSON.stringify(params))
    ) {
      return {
        block: true,
        blockReason:
          "AI 不得代替人工确认财务流水；请授权人员直接在飞书表中完成“人工已确认”。",
      };
    }
  };
}

function isFeishuTurn(context = {}) {
  return [context.channel, context.messageProvider]
    .map((value) => String(value ?? "").toLowerCase())
    .includes("feishu");
}

function pruneCompletedRuns(now) {
  for (const [runId, completedAt] of completedRuns) {
    if (now - completedAt > DEDUPE_TTL_MS) completedRuns.delete(runId);
  }
}

async function sendCard(fetchImpl, token, recipient, card) {
  const endpoint = new URL(
    "https://open.feishu.cn/open-apis/im/v1/messages",
  );
  endpoint.searchParams.set("receive_id_type", recipient.type);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id: recipient.id,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) {
    throw new Error(
      `Feishu card send failed: HTTP ${response.status}, code ${result.code ?? "unknown"}, msg ${result.msg ?? "unknown"}`,
    );
  }
  return result.data?.message_id;
}

export function createAgentEndHandler(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? appendLog;
  const financeRecipientIds =
    options.financeRecipientIds ?? FINANCE_RECIPIENT_ALLOWLIST;

  return async function onAgentEnd(event = {}, context = {}) {
    if (!isFeishuTurn(context) || event.success === false) return;

    const recipient = resolveRecipient(context);
    if (!recipient) {
      await logger("skip-agent-end: Feishu recipient unavailable");
      return;
    }

    const now = Date.now();
    pruneCompletedRuns(now);
    const runId = String(event.runId ?? context.runId ?? "").trim();
    if (runId && completedRuns.has(runId)) return;
    if (runId) completedRuns.set(runId, now);

    try {
      const token = await getTenantAccessToken(fetchImpl);
      const sessionRecipient = resolveSessionRecipient(context);
      const includeFinance =
        financeRecipientIds.has(recipient.id) ||
        (
          String(context.sessionKey ?? "").includes(":feishu:direct:") &&
          financeRecipientIds.has(sessionRecipient)
        );
      const messageIds = await Promise.all(
        buildCards({ includeFinance }).map((card) =>
          sendCard(fetchImpl, token, recipient, card),
        ),
      );
      await logger(
        `sent-agent-end: ${recipient.type}, run=${runId || "unknown"}, messages=${messageIds.filter(Boolean).join(",") || "unknown"}`,
      );
    } catch (error) {
      if (runId) completedRuns.delete(runId);
      await logger(
        `error-agent-end: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
