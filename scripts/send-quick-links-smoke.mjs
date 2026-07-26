#!/usr/bin/env node

import { createAgentEndHandler } from "../openclaw-plugins/board-quick-links/runtime.js";

const recipient = String(process.argv[2] ?? "").trim();
if (!recipient.startsWith("ou_") && !recipient.startsWith("oc_")) {
  throw new Error(
    "用法：send-quick-links-smoke.mjs <ou_用户OpenID或oc_会话ID>",
  );
}

const logs = [];
const handler = createAgentEndHandler({
  logger: async (line) => logs.push(line),
});
await handler(
  { runId: `quick-links-smoke-${Date.now()}`, success: true },
  {
    channel: "feishu",
    messageProvider: "feishu",
    ...(recipient.startsWith("oc_")
      ? { chatId: recipient }
      : { senderId: recipient }),
  },
);
const sent = logs.find((line) => line.startsWith("sent-agent-end:"));
if (!sent) {
  throw new Error(`三卡片真实发送失败：${logs.join("; ") || "没有日志"}`);
}
console.log(JSON.stringify({ sent: true, cards: 3, log: sent }));
