#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 root 运行 import-migration-state.sh" >&2
  exit 1
fi

SOURCE="${1:-}"
SERVICE_HOME="/var/lib/autoboard"
OPENCLAW_STATE="${SERVICE_HOME}/.openclaw"
INSTALL_ROOT="/opt/autoboard"

if [[ -z "${SOURCE}" || ! -d "${SOURCE}" ]]; then
  echo "用法：import-migration-state.sh <迁移导出目录>" >&2
  exit 1
fi
for required in \
  "${SOURCE}/openclaw-source.json" \
  "${SOURCE}/agents/main/agent/openclaw-agent.sqlite" \
  "${SOURCE}/agents/main/agent/models.json"; do
  if [[ ! -f "${required}" ]]; then
    echo "迁移导出不完整，缺少：${required}" >&2
    exit 1
  fi
done

if [[ -s "${OPENCLAW_STATE}/openclaw.json" ]]; then
  "${INSTALL_ROOT}/deploy/backup.sh"
fi
systemctl stop autoboard-openclaw.service 2>/dev/null || true

install -d -o autoboard -g autoboard -m 0700 \
  "${OPENCLAW_STATE}" \
  "${OPENCLAW_STATE}/credentials" \
  "${OPENCLAW_STATE}/agents/main/agent"
install -d -o autoboard -g autoboard -m 0750 \
  "${OPENCLAW_STATE}/workspace/state"

node "${INSTALL_ROOT}/deploy/migrate-config.mjs" \
  "${SOURCE}/openclaw-source.json" \
  "${OPENCLAW_STATE}/openclaw.json" >/dev/null
rm -f \
  "${OPENCLAW_STATE}/agents/main/agent/openclaw-agent.sqlite" \
  "${OPENCLAW_STATE}/agents/main/agent/openclaw-agent.sqlite-wal" \
  "${OPENCLAW_STATE}/agents/main/agent/openclaw-agent.sqlite-shm"
install -o autoboard -g autoboard -m 0600 \
  "${SOURCE}/agents/main/agent/openclaw-agent.sqlite" \
  "${OPENCLAW_STATE}/agents/main/agent/openclaw-agent.sqlite"
install -o autoboard -g autoboard -m 0600 \
  "${SOURCE}/agents/main/agent/models.json" \
  "${OPENCLAW_STATE}/agents/main/agent/models.json"

rm -f \
  "${OPENCLAW_STATE}/credentials/feishu-default-allowFrom.json" \
  "${OPENCLAW_STATE}/credentials/feishu-pairing.json"
for credential in \
  feishu-default-allowFrom.json \
  feishu-pairing.json; do
  if [[ -f "${SOURCE}/credentials/${credential}" ]]; then
    install -o autoboard -g autoboard -m 0600 \
      "${SOURCE}/credentials/${credential}" \
      "${OPENCLAW_STATE}/credentials/${credential}"
  fi
done
rm -f "${OPENCLAW_STATE}/workspace/state/task-journal-snapshot.json"
if [[ -f "${SOURCE}/workspace/state/task-journal-snapshot.json" ]]; then
  install -o autoboard -g autoboard -m 0600 \
    "${SOURCE}/workspace/state/task-journal-snapshot.json" \
    "${OPENCLAW_STATE}/workspace/state/task-journal-snapshot.json"
fi
rm -f "${OPENCLAW_STATE}/workspace/state/financial-control.json"
if [[ -f "${SOURCE}/workspace/state/financial-control.json" ]]; then
  install -o autoboard -g autoboard -m 0600 \
    "${SOURCE}/workspace/state/financial-control.json" \
    "${OPENCLAW_STATE}/workspace/state/financial-control.json"
fi

chown -R autoboard:autoboard "${OPENCLAW_STATE}"
find "${OPENCLAW_STATE}/credentials" -type f -exec chmod 0600 {} +
chmod 0600 \
  "${OPENCLAW_STATE}/openclaw.json" \
  "${OPENCLAW_STATE}/agents/main/agent/openclaw-agent.sqlite" \
  "${OPENCLAW_STATE}/agents/main/agent/models.json"

if [[ ! -s "${OPENCLAW_STATE}/workspace/state/task-journal-snapshot.json" ]]; then
  ENV_FILE="/etc/autoboard/autoboard.env"
  AUTOBOARD_ENV=()
  if [[ -r "${ENV_FILE}" ]]; then
    mapfile -t AUTOBOARD_ENV < <(
      sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "${ENV_FILE}"
    )
  fi
  runuser -u autoboard -- env \
    "${AUTOBOARD_ENV[@]}" \
    HOME="${SERVICE_HOME}" \
    OPENCLAW_HOME="${SERVICE_HOME}" \
    OPENCLAW_STATE_DIR="${OPENCLAW_STATE}" \
    OPENCLAW_CONFIG_PATH="${OPENCLAW_STATE}/openclaw.json" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    AUTOBOARD_STATE_DIR="${OPENCLAW_STATE}/workspace/state" \
    node "${INSTALL_ROOT}/scripts/task-journal.mjs" baseline
fi

echo "迁移状态已导入。现在运行："
echo "  ${INSTALL_ROOT}/deploy/configure-runtime.sh"
echo "验证成功后，请安全删除迁移导出目录。"
