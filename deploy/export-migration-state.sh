#!/usr/bin/env bash
set -euo pipefail

SOURCE_HOME="${OPENCLAW_HOME:-${HOME}}"
SOURCE_STATE="${OPENCLAW_STATE_DIR:-${SOURCE_HOME}/.openclaw}"
DESTINATION="${1:-}"

if [[ -z "${DESTINATION}" ]]; then
  echo "用法：export-migration-state.sh <空的导出目录>" >&2
  exit 1
fi
if [[ -e "${DESTINATION}" ]]; then
  echo "导出目录已存在，请换一个新目录：${DESTINATION}" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "缺少 sqlite3，无法一致性导出模型认证数据库" >&2
  exit 1
fi

CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${SOURCE_STATE}/openclaw.json}"
AUTH_DB="${SOURCE_STATE}/agents/main/agent/openclaw-agent.sqlite"
MODELS_PATH="${SOURCE_STATE}/agents/main/agent/models.json"
SNAPSHOT_PATH="${SOURCE_STATE}/workspace/state/task-journal-snapshot.json"
FINANCE_STATE_PATH="${SOURCE_STATE}/workspace/state/financial-control.json"

for required in "${CONFIG_PATH}" "${AUTH_DB}" "${MODELS_PATH}"; do
  if [[ ! -f "${required}" ]]; then
    echo "缺少迁移源文件：${required}" >&2
    exit 1
  fi
done

install -d -m 0700 \
  "${DESTINATION}" \
  "${DESTINATION}/credentials" \
  "${DESTINATION}/agents/main/agent" \
  "${DESTINATION}/workspace/state"
install -m 0600 "${CONFIG_PATH}" "${DESTINATION}/openclaw-source.json"
sqlite3 "${AUTH_DB}" ".backup '${DESTINATION}/agents/main/agent/openclaw-agent.sqlite'"
install -m 0600 "${MODELS_PATH}" "${DESTINATION}/agents/main/agent/models.json"

for credential in \
  feishu-default-allowFrom.json \
  feishu-pairing.json; do
  if [[ -f "${SOURCE_STATE}/credentials/${credential}" ]]; then
    install -m 0600 \
      "${SOURCE_STATE}/credentials/${credential}" \
      "${DESTINATION}/credentials/${credential}"
  fi
done
if [[ -f "${SNAPSHOT_PATH}" ]]; then
  install -m 0600 \
    "${SNAPSHOT_PATH}" \
    "${DESTINATION}/workspace/state/task-journal-snapshot.json"
fi
if [[ -f "${FINANCE_STATE_PATH}" ]]; then
  install -m 0600 \
    "${FINANCE_STATE_PATH}" \
    "${DESTINATION}/workspace/state/financial-control.json"
fi

find "${DESTINATION}" -type f -exec chmod 0600 {} +
echo "迁移状态已一致性导出到：${DESTINATION}"
