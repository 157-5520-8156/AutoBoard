#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 root 运行 configure-runtime.sh" >&2
  exit 1
fi

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
    "$@"
}

if [[ ! -s "${OPENCLAW_HOME}/openclaw.json" ]]; then
  echo "缺少 ${OPENCLAW_HOME}/openclaw.json" >&2
  exit 1
fi

run_as_autoboard openclaw config validate

run_as_autoboard node \
  "${INSTALL_ROOT}/deploy/patch-feishu-events.mjs" --check

run_as_autoboard node \
  "${INSTALL_ROOT}/scripts/financial-control.mjs" setup
run_as_autoboard node \
  "${INSTALL_ROOT}/scripts/financial-control.mjs" configure-workspace
run_as_autoboard node \
  "${INSTALL_ROOT}/scripts/financial-control.mjs" sync

chown -R autoboard:autoboard "${SERVICE_HOME}"
find "${OPENCLAW_HOME}/credentials" -type f -exec chmod 0600 {} + 2>/dev/null || true
chmod 0600 "${OPENCLAW_HOME}/openclaw.json"

systemctl restart autoboard-openclaw.service

for attempt in {1..30}; do
  if systemctl is-active --quiet autoboard-openclaw.service; then
    if run_as_autoboard openclaw health >/dev/null 2>&1; then
      break
    fi
  fi
  if [[ ${attempt} -eq 30 ]]; then
    journalctl -u autoboard-openclaw.service -n 100 --no-pager >&2
    exit 1
  fi
  sleep 2
done

run_as_autoboard openclaw cron add \
  --name "任务工作日记-每小时漏记补偿" \
  --display-name "任务工作日记：每小时漏记补偿" \
  --description "事件实时记录为主；每小时重放失败事件并扫描当前状态" \
  --every 1h \
  --session isolated \
  --command-argv '["/usr/local/bin/node","/opt/autoboard/scripts/task-journal.mjs","recover"]' \
  --command-cwd "${INSTALL_ROOT}" \
  --timeout-seconds 120 \
  --no-deliver \
  --declaration-key autoboard.task-journal.sync.v1

run_as_autoboard openclaw cron add \
  --name "任务工作日记-每日汇总" \
  --display-name "任务工作日记：每日汇总" \
  --description "每天00:05汇总前一天的自动变更和手工日记" \
  --cron "5 0 * * *" \
  --tz Asia/Shanghai \
  --exact \
  --session isolated \
  --command-argv '["/usr/local/bin/node","/opt/autoboard/scripts/task-journal.mjs","summary"]' \
  --command-cwd "${INSTALL_ROOT}" \
  --timeout-seconds 120 \
  --no-deliver \
  --declaration-key autoboard.task-journal.summary.v1

run_as_autoboard openclaw cron add \
  --name "财务风控-定时核对与补偿" \
  --display-name "财务风控：定时核对与补偿" \
  --description "实时事件触发为主；每15分钟重新汇总预算、承诺、义务、付款和风险" \
  --every 15m \
  --session isolated \
  --command-argv '["/usr/local/bin/node","/opt/autoboard/scripts/financial-control.mjs","recover"]' \
  --command-cwd "${INSTALL_ROOT}" \
  --timeout-seconds 180 \
  --no-deliver \
  --declaration-key autoboard.financial-control.reconcile.v1

"${INSTALL_ROOT}/deploy/healthcheck.sh"
