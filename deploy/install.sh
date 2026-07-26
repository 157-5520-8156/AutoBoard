#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 root 运行 install.sh" >&2
  exit 1
fi

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="/opt/autoboard"
SERVICE_HOME="/var/lib/autoboard"
OPENCLAW_HOME="${SERVICE_HOME}/.openclaw"
ENV_DIR="/etc/autoboard"
BACKUP_DIR="/var/backups/autoboard"
NODE_VERSION="24.15.0"
OPENCLAW_VERSION="2026.7.1-2"
FEISHU_VERSION="2026.7.1"
DEEPSEEK_VERSION="2026.7.1"
SOURCE_ROOT="${PACKAGE_ROOT}"
STAGED_SOURCE=""

case "${PACKAGE_ROOT}/" in
  "${INSTALL_ROOT}/"*)
    STAGED_SOURCE="$(mktemp -d /tmp/autoboard-install.XXXXXX)"
    cp -a "${PACKAGE_ROOT}/." "${STAGED_SOURCE}/"
    SOURCE_ROOT="${STAGED_SOURCE}"
    ;;
esac

cleanup_staged_source() {
  if [[ -n "${STAGED_SOURCE}" && "${STAGED_SOURCE}" == /tmp/autoboard-install.* ]]; then
    rm -rf -- "${STAGED_SOURCE}"
  fi
}
trap cleanup_staged_source EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils

if ! id autoboard >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "${SERVICE_HOME}" --shell /usr/sbin/nologin autoboard
fi

install -d -m 0755 "${INSTALL_ROOT}" "${ENV_DIR}"
install -d -o autoboard -g autoboard -m 0700 "${OPENCLAW_HOME}"
install -d -o autoboard -g autoboard -m 0750 "${BACKUP_DIR}"

if [[ -d "${INSTALL_ROOT}/scripts" ]]; then
  timestamp="$(date +%Y%m%d-%H%M%S)"
  install -d -m 0750 "${BACKUP_DIR}/package-${timestamp}"
  cp -a "${INSTALL_ROOT}/." "${BACKUP_DIR}/package-${timestamp}/"
fi

find "${INSTALL_ROOT}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a "${SOURCE_ROOT}/." "${INSTALL_ROOT}/"
chown -R root:root "${INSTALL_ROOT}"
find "${INSTALL_ROOT}" -type d -exec chmod 0755 {} +
find "${INSTALL_ROOT}" -type f -exec chmod 0644 {} +
chmod 0755 \
  "${INSTALL_ROOT}/deploy/install.sh" \
  "${INSTALL_ROOT}/deploy/export-migration-state.sh" \
  "${INSTALL_ROOT}/deploy/import-migration-state.sh" \
  "${INSTALL_ROOT}/deploy/configure-runtime.sh" \
  "${INSTALL_ROOT}/deploy/healthcheck.sh" \
  "${INSTALL_ROOT}/deploy/backup.sh" \
  "${INSTALL_ROOT}/scripts/financial-control.mjs"

machine_arch="$(uname -m)"
case "${machine_arch}" in
  x86_64) node_arch="x64" ;;
  aarch64|arm64) node_arch="arm64" ;;
  *)
    echo "不支持的 CPU 架构：${machine_arch}" >&2
    exit 1
    ;;
esac

node_root="/usr/local/lib/node-v${NODE_VERSION}-linux-${node_arch}"
if [[ ! -x "${node_root}/bin/node" ]]; then
  node_archive="/tmp/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  curl --fail --location --retry 3 \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    --output "${node_archive}"
  tar -xJf "${node_archive}" -C /usr/local/lib
  rm -f "${node_archive}"
fi

for binary in node npm npx corepack; do
  ln -sfn "${node_root}/bin/${binary}" "/usr/local/bin/${binary}"
done

npm install --global "openclaw@${OPENCLAW_VERSION}"
ln -sfn "${node_root}/bin/openclaw" /usr/local/bin/openclaw

run_as_autoboard() {
  runuser -u autoboard -- env \
    HOME="${SERVICE_HOME}" \
    OPENCLAW_HOME="${SERVICE_HOME}" \
    OPENCLAW_STATE_DIR="${OPENCLAW_HOME}" \
    OPENCLAW_CONFIG_PATH="${OPENCLAW_HOME}/openclaw.json" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

if [[ ! -f "${OPENCLAW_HOME}/openclaw.json" ]]; then
  run_as_autoboard openclaw setup \
    --baseline \
    --workspace "${OPENCLAW_HOME}/workspace"
fi

install -d -o autoboard -g autoboard -m 0750 "${OPENCLAW_HOME}/workspace"
cp -a "${INSTALL_ROOT}/workspace/." "${OPENCLAW_HOME}/workspace/"

run_as_autoboard openclaw plugins install \
  --force --pin "npm:@openclaw/feishu@${FEISHU_VERSION}"
run_as_autoboard openclaw plugins install \
  --force --pin "npm:@openclaw/deepseek-provider@${DEEPSEEK_VERSION}"
run_as_autoboard openclaw plugins install \
  --link "${INSTALL_ROOT}/openclaw-plugins/board-quick-links"

run_as_autoboard node \
  "${INSTALL_ROOT}/deploy/patch-feishu-events.mjs"

if [[ ! -f "${ENV_DIR}/autoboard.env" ]]; then
  install -m 0640 -o root -g autoboard \
    "${INSTALL_ROOT}/deploy/autoboard.env.example" \
    "${ENV_DIR}/autoboard.env"
fi

install -m 0644 \
  "${INSTALL_ROOT}/deploy/autoboard-openclaw.service" \
  /etc/systemd/system/autoboard-openclaw.service

chown -R autoboard:autoboard "${SERVICE_HOME}"
systemctl daemon-reload
systemctl enable autoboard-openclaw.service

echo
echo "基础软件和插件安装完成。"
echo "迁移 openclaw.json、模型认证和配对凭据后，运行："
echo "  /opt/autoboard/deploy/configure-runtime.sh"
