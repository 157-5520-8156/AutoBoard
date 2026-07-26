#!/usr/bin/env bash
set -euo pipefail

SERVICE_HOME="/var/lib/autoboard"
OPENCLAW_HOME="${SERVICE_HOME}/.openclaw"
BACKUP_DIR="/var/backups/autoboard"
timestamp="$(date +%Y%m%d-%H%M%S)"
destination="${BACKUP_DIR}/${timestamp}"

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 root 运行 backup.sh" >&2
  exit 1
fi

install -d -o autoboard -g autoboard -m 0750 "${destination}"
runuser -u autoboard -- env \
  HOME="${SERVICE_HOME}" \
  OPENCLAW_HOME="${SERVICE_HOME}" \
  OPENCLAW_STATE_DIR="${OPENCLAW_HOME}" \
  OPENCLAW_CONFIG_PATH="${OPENCLAW_HOME}/openclaw.json" \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  openclaw backup create \
    --output "${destination}" \
    --verify \
    --json

cp -a /etc/autoboard "${destination}/etc-autoboard"
chmod -R go-rwx "${destination}/etc-autoboard"
echo "备份完成：${destination}"
