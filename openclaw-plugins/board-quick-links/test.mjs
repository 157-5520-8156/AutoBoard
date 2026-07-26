import assert from "node:assert/strict";
import {
  buildCards,
  createAgentEndHandler,
  createBeforeToolCallHandler,
  resolveRecipient,
  resolveSessionRecipient,
} from "./runtime.js";

const calls = [];
const logs = [];
const fetchImpl = async (url, options = {}) => {
  calls.push({ url: String(url), body: options.body });
  if (String(url).includes("tenant_access_token")) {
    return new Response(
      JSON.stringify({
        code: 0,
        tenant_access_token: "test-token",
        expire: 7200,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({
      code: 0,
      data: { message_id: `test-${calls.length}` },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

assert.deepEqual(resolveRecipient({ chatId: "oc_test" }), {
  id: "oc_test",
  type: "chat_id",
});
assert.deepEqual(resolveRecipient({ channelId: "ou_test" }), {
  id: "ou_test",
  type: "open_id",
});
assert.equal(buildCards().length, 3);
assert.equal(
  resolveSessionRecipient({
    sessionKey: "agent:main:feishu:direct:ou_test",
  }),
  "ou_test",
);

const toolGuard = createBeforeToolCallHandler({
  financeRecipientIds: new Set(["ou_owner"]),
  financeBaseToken: "finance_base",
});
assert.equal(
  (
    await toolGuard(
      {
        toolName: "feishu_bitable_list_records",
        params: { app_token: "finance_base" },
      },
      { sessionKey: "agent:main:feishu:direct:ou_other" },
    )
  ).block,
  true,
);
assert.equal(
  (
    await toolGuard(
      {
        toolName: "exec",
        params: { command: "curl arbitrary" },
      },
      { sessionKey: "agent:main:feishu:direct:ou_owner" },
    )
  ).block,
  true,
);
assert.equal(
  (
    await toolGuard(
      {
        toolName: "read",
        params: { path: "/etc/autoboard/autoboard.env" },
      },
      { sessionKey: "agent:main:feishu:isolated:unknown" },
    )
  ).block,
  true,
);
assert.equal(
  (
    await toolGuard(
      {
        toolName: "exec",
        params: { command: "anything" },
      },
      { sessionKey: "agent:main:feishu:direct:ou_other" },
    )
  ).block,
  true,
);
assert.equal(
  (
    await toolGuard(
      {
        toolName: "feishu_bitable_batch_update_records",
        params: {
          app_token: "finance_base",
          records: [
            { fields: { "数据确认状态": "人工已确认" } },
          ],
        },
      },
      { sessionKey: "agent:main:feishu:direct:ou_owner" },
    )
  ).block,
  true,
);
assert.equal(
  (
    await toolGuard(
      {
        toolName: "feishu_bitable_update_record",
        params: {
          app_token: "finance_base",
          fields: { "数据确认状态": "人工已确认" },
        },
      },
      { sessionKey: "agent:main:feishu:direct:ou_owner" },
    )
  ).block,
  true,
);
assert.equal(
  await toolGuard(
    {
      toolName: "feishu_bitable_create_record",
      params: {
        app_token: "finance_base",
        fields: { "数据确认状态": "AI草稿" },
      },
    },
    { sessionKey: "agent:main:feishu:direct:ou_owner" },
  ),
  undefined,
);

const handler = createAgentEndHandler({
  fetchImpl,
  logger: async (line) => logs.push(line),
  financeRecipientIds: new Set(["oc_test"]),
});
const event = { runId: "run-test", success: true };
const context = {
  channel: "feishu",
  messageProvider: "feishu",
  chatId: "oc_test",
  senderId: "ou_test",
};

await handler(event, context);
await handler(event, context);

const sends = calls.filter(({ url }) => url.includes("/im/v1/messages"));
assert.equal(sends.length, 3);
assert.deepEqual(
  sends.map(({ body }) => {
    const request = JSON.parse(body);
    return JSON.parse(request.content).header.title.content;
  }),
  ["部长协作大看板", "日记按天看板", "财务签前审查看板"],
);
assert.equal(logs.length, 1);
assert.match(logs[0], /^sent-agent-end:/);

const restrictedLogs = [];
const restrictedHandler = createAgentEndHandler({
  fetchImpl,
  logger: async (line) => restrictedLogs.push(line),
  financeRecipientIds: new Set(),
});
await restrictedHandler(
  { runId: "run-restricted", success: true },
  context,
);
const allSends = calls.filter(({ url }) => url.includes("/im/v1/messages"));
assert.equal(allSends.length, 5);
assert.deepEqual(
  allSends.slice(3).map(({ body }) => {
    const request = JSON.parse(body);
    return JSON.parse(request.content).header.title.content;
  }),
  ["部长协作大看板", "日记按天看板"],
);
assert.equal(restrictedLogs.length, 1);

const directOwnerHandler = createAgentEndHandler({
  fetchImpl,
  logger: async () => {},
  financeRecipientIds: new Set(["ou_owner"]),
});
await directOwnerHandler(
  { runId: "run-direct-owner", success: true },
  {
    channel: "feishu",
    chatId: "oc_direct_chat",
    sessionKey: "agent:main:feishu:direct:ou_owner",
  },
);
assert.equal(
  calls.filter(({ url }) => url.includes("/im/v1/messages")).length,
  8,
);

console.log(
  JSON.stringify({
    agentEndTriggered: true,
    interactiveCardSends: sends.length,
    duplicateRunSuppressed: true,
    financeCardRestrictedByRecipient: true,
    financeToolAclEnforced: true,
    aiCannotSelfConfirm: true,
  }),
);
