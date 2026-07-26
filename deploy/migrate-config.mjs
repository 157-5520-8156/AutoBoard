#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const sourcePath = process.argv[2];
const targetPath = process.argv[3];
if (!sourcePath || !targetPath) {
  throw new Error(
    "Usage: migrate-config.mjs <source-openclaw.json> <target-openclaw.json>",
  );
}

const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
if (!source.channels?.feishu?.appId || !source.channels?.feishu?.appSecret) {
  throw new Error("源配置缺少飞书 appId/appSecret");
}

const sourceDefaults = source.agents?.defaults ?? {};
const defaultModels = Object.fromEntries(
  Object.entries(sourceDefaults.models ?? {}).filter(
    ([model]) => !model.startsWith("openai/"),
  ),
);
const imageModelRef =
  typeof sourceDefaults.imageModel === "string"
    ? sourceDefaults.imageModel
    : sourceDefaults.imageModel?.primary;
const migratedDefaults = {
  ...sourceDefaults,
  models: defaultModels,
  workspace: "/var/lib/autoboard/.openclaw/workspace",
};
if (typeof imageModelRef === "string" && imageModelRef.startsWith("openai/")) {
  delete migratedDefaults.imageModel;
}

const target = {
  meta: {
    ...source.meta,
    lastTouchedVersion: "2026.7.1-2",
    lastTouchedAt: new Date().toISOString(),
  },
  plugins: {
    allow: ["feishu", "deepseek", "autoboard-quick-links"],
    entries: {
      feishu: { enabled: true },
      deepseek: { enabled: true },
      "autoboard-quick-links": {
        enabled: true,
        hooks: { allowConversationAccess: true },
      },
    },
    load: {
      paths: ["/opt/autoboard/openclaw-plugins/board-quick-links"],
    },
  },
  channels: {
    feishu: {
      ...source.channels.feishu,
      enabled: true,
      connectionMode: "websocket",
    },
  },
  gateway: {
    auth: {
      mode: "token",
      token: crypto.randomBytes(32).toString("hex"),
    },
    mode: "local",
    port: 18789,
    bind: "loopback",
  },
  agents: {
    defaults: {
      ...migratedDefaults,
    },
  },
  ...(source.session ? { session: source.session } : {}),
  ...(source.tools ? { tools: source.tools } : {}),
  ...(source.auth ? { auth: source.auth } : {}),
  ...(source.models ? { models: source.models } : {}),
  ...(source.skills ? { skills: source.skills } : {}),
  ...(source.wizard ? { wizard: source.wizard } : {}),
  ...(source.commands ? { commands: source.commands } : {}),
  hooks: {
    internal: {
      enabled: true,
      entries: {
        "session-memory": { enabled: true },
        "board-quick-links": { enabled: false },
      },
    },
  },
};

await fs.mkdir(path.dirname(targetPath), { recursive: true });
await fs.writeFile(targetPath, `${JSON.stringify(target, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
await fs.chmod(targetPath, 0o600);
console.log(
  JSON.stringify({
    migrated: true,
    targetPath,
    appId: target.channels.feishu.appId,
    secretIncluded: true,
    gatewayTokenRotated: true,
  }),
);
