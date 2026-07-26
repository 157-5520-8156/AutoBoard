import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createAgentEndHandler,
  createBeforeToolCallHandler,
} from "./runtime.js";

export default definePluginEntry({
  id: "autoboard-quick-links",
  name: "AutoBoard Quick Links",
  description:
    "Sends task, daily-journal, and financial-control cards after each Feishu agent turn.",
  register(api) {
    api.on("before_tool_call", createBeforeToolCallHandler(), {
      priority: 100,
      timeoutMs: 5_000,
    });
    api.on("agent_end", createAgentEndHandler(), {
      priority: 10,
      timeoutMs: 20_000,
    });
  },
});
