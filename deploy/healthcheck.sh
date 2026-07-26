#!/usr/bin/env bash
set -euo pipefail

SERVICE_HOME="/var/lib/autoboard"
OPENCLAW_HOME="${SERVICE_HOME}/.openclaw"
INSTALL_ROOT="/opt/autoboard"
ENV_FILE="/etc/autoboard/autoboard.env"
AUTOBOARD_ENV=()
if [[ -r "${ENV_FILE}" ]]; then
  mapfile -t AUTOBOARD_ENV < <(
    sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "${ENV_FILE}"
  )
fi

run_as_autoboard() {
  runuser -u autoboard -- env \
    "${AUTOBOARD_ENV[@]}" \
    HOME="${SERVICE_HOME}" \
    OPENCLAW_HOME="${SERVICE_HOME}" \
    OPENCLAW_STATE_DIR="${OPENCLAW_HOME}" \
    OPENCLAW_CONFIG_PATH="${OPENCLAW_HOME}/openclaw.json" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    AUTOBOARD_STATE_DIR="${OPENCLAW_HOME}/workspace/state" \
    "$@"
}

systemctl is-active --quiet autoboard-openclaw.service
run_as_autoboard openclaw config validate
run_as_autoboard openclaw health
run_as_autoboard openclaw plugins inspect \
  autoboard-quick-links --runtime --json |
  grep -q '"name": "agent_end"'
run_as_autoboard node \
  "${INSTALL_ROOT}/deploy/patch-feishu-events.mjs" --check
journal_status="$(
  run_as_autoboard node \
    "${INSTALL_ROOT}/scripts/task-journal.mjs" status
)"
echo "${journal_status}"
printf '%s' "${journal_status}" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const status = JSON.parse(input);
    if (status.journalTable?.name !== "任务工作日记") {
      throw new Error("任务工作日记表缺失");
    }
    const fields = new Set(status.journalTable.fieldNames ?? []);
    const missingFields = (status.requiredFieldNames ?? []).filter(
      (field) => !fields.has(field),
    );
    if (missingFields.length > 0) {
      throw new Error(`任务工作日记字段不完整：${missingFields.join("、")}`);
    }
    const schema = new Map(
      (status.journalTable.fieldSchema ?? []).map((field) => [field.name, field]),
    );
    const incompatibleFields = (status.requiredFieldSchema ?? []).filter(
      (expected) => {
        const actual = schema.get(expected.name);
        if (!actual || actual.type !== expected.type) return true;
        if (!expected.relation) return false;
        return (
          actual.relation?.tableId !== expected.relation.tableId ||
          actual.relation?.multiple !== expected.relation.multiple
        );
      },
    );
    if (incompatibleFields.length > 0) {
      throw new Error(
        `任务工作日记字段类型不兼容：${incompatibleFields
          .map((field) => field.name)
          .join("、")}`,
      );
    }
    if (!status.snapshot?.capturedAt || !Number.isInteger(status.snapshot.taskRows)) {
      throw new Error("任务快照缺失或无效");
    }
    if (
      status.dailyBoard?.type !== "kanban" ||
      !status.dailyBoard.groupFields?.includes("日期分组")
    ) {
      throw new Error("“日记按天看板”缺失或未按“日期分组”分列");
    }
    if ((status.eventQueue?.deadLetters ?? 0) > 0) {
      throw new Error(
        `存在 ${status.eventQueue.deadLetters} 个死信事件；修复原因后运行 task-journal.mjs retry-dead-letters`,
      );
    }
  });
'

finance_status="$(
  run_as_autoboard node \
    "${INSTALL_ROOT}/scripts/financial-control.mjs" status
)"
echo "${finance_status}"
printf '%s' "${finance_status}" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const status = JSON.parse(input);
    if (status.baseName !== "经济事项与财务风控") {
      throw new Error("财务风控 Base 缺失");
    }
    const tables = Object.values(status.tables ?? {});
    if (tables.length !== 9) {
      throw new Error(`财务风控表数量错误：${tables.length}`);
    }
    const broken = tables.filter(
      (table) =>
        (table.missing ?? []).length > 0 ||
        (table.incompatible ?? []).length > 0,
    );
    if (broken.length > 0) {
      throw new Error(
        `财务风控表结构不完整：${broken.map((table) => table.name).join("、")}`,
      );
    }
    if (
      status.boardView?.name !== "签前审查看板" ||
      status.boardView?.type !== "kanban" ||
      !status.boardView?.groupFields?.includes("当前阶段")
    ) {
      throw new Error("财务签前审查看板缺失");
    }
    if (status.dashboard?.name !== "财务风控总览") {
      throw new Error("财务风控仪表盘缺失");
    }
    const requiredBlocks = new Set([
      "有效预算合计",
      "合同承诺合计",
      "已确认义务合计",
      "已付款合计",
      "事项风险分布",
      "各部门预算与付款",
    ]);
    for (const block of status.dashboard.blocks ?? []) {
      requiredBlocks.delete(block);
    }
    if (requiredBlocks.size > 0) {
      throw new Error(
        `财务风控仪表盘区块缺失：${[...requiredBlocks].join("、")}`,
      );
    }
    if (
      !status.crossModule?.configured ||
      !status.crossModule?.taskField ||
      !status.crossModule?.journalField ||
      !status.crossModule?.journalIdField
    ) {
      throw new Error("财务事项与任务/日记的双向编号字段缺失");
    }
  });
'

cron_status="$(run_as_autoboard openclaw cron list --json)"
echo "${cron_status}"
printf '%s' "${cron_status}" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const { jobs = [] } = JSON.parse(input);
    const byKey = new Map(jobs.map((job) => [job.declarationKey, job]));
    const sync = byKey.get("autoboard.task-journal.sync.v1");
    const summary = byKey.get("autoboard.task-journal.summary.v1");
    const finance = byKey.get(
      "autoboard.financial-control.reconcile.v1",
    );
    if (
      !sync?.enabled ||
      sync.schedule?.kind !== "every" ||
      sync.schedule?.everyMs !== 3600000 ||
      JSON.stringify(sync.payload?.argv) !==
        JSON.stringify([
          "/usr/local/bin/node",
          "/opt/autoboard/scripts/task-journal.mjs",
          "recover",
        ])
    ) {
      throw new Error("每小时漏记补偿任务缺失或配置错误");
    }
    if (
      !summary?.enabled ||
      summary.schedule?.kind !== "cron" ||
      summary.schedule?.expr !== "5 0 * * *" ||
      summary.schedule?.tz !== "Asia/Shanghai" ||
      JSON.stringify(summary.payload?.argv) !==
        JSON.stringify([
          "/usr/local/bin/node",
          "/opt/autoboard/scripts/task-journal.mjs",
          "summary",
        ])
    ) {
      throw new Error("每日汇总任务缺失或配置错误");
    }
    if (
      !finance?.enabled ||
      finance.schedule?.kind !== "every" ||
      finance.schedule?.everyMs !== 900000 ||
      JSON.stringify(finance.payload?.argv) !==
        JSON.stringify([
          "/usr/local/bin/node",
          "/opt/autoboard/scripts/financial-control.mjs",
          "recover",
        ])
    ) {
      throw new Error("财务风控定时核对任务缺失或配置错误");
    }
  });
'

echo "AutoBoard healthcheck: OK"
