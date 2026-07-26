# AutoBoard 服务器部署包

此部署包用于在 Ubuntu 24.04 上运行领导交办任务看板、飞书机器人、
按负责人协作看板、按天日记、财务签前风控、实时变更记录、快捷入口卡片及定时补偿任务。

财务风控使用独立的“经济事项与财务风控”多维表格，包含经济事项、
预算调整、合同与承诺、履约验收、发票、付款、风险处置、财务变更日志和
规则配置九张表。汇总金额和红黄预警由确定性规则计算；AI 只负责把笔记或
附件转换成待核对的结构化草稿，不直接裁定合规性。

## 固定运行目录

- 程序：`/opt/autoboard`
- OpenClaw 状态：`/var/lib/autoboard/.openclaw`
- 非密钥环境配置：`/etc/autoboard/autoboard.env`
- 备份：`/var/backups/autoboard`
- systemd 服务：`autoboard-openclaw.service`

## 安装顺序

1. 以 root 解压部署包。安装器支持从任意目录运行，包括
   `/opt/autoboard` 原地重装；原地运行时会先复制到受控临时目录。
2. 运行 `deploy/install.sh`。
3. 在原机器运行一致性导出脚本，再通过 `scp` 等安全通道把整个导出目录
   传到服务器临时目录：

   ```bash
   ./deploy/export-migration-state.sh \
     /tmp/autoboard-migration-export
   ```

   脚本使用 SQLite `.backup` 导出模型认证数据库，可安全处理 WAL 模式；
   不要直接复制运行中的 `openclaw-agent.sqlite`。
4. 在服务器运行导入脚本。它会备份正在运行的旧状态、停止服务、将文件安装到
   正确路径，并调用 `migrate-config.mjs` 改写运行路径、轮换 Gateway Token、
   移除已弃用的 OpenAI 模型引用并建立插件白名单：

   ```bash
   /opt/autoboard/deploy/import-migration-state.sh \
     /tmp/autoboard-migration-export
   ```

5. 运行 `deploy/configure-runtime.sh`。
6. 运行 `deploy/healthcheck.sh`。
7. 验证成功后，安全删除服务器和原机器上的临时迁移导出目录。

## 升级约束

本包锁定 OpenClaw `2026.7.1-2` 和 Feishu 插件 `2026.7.1`。实时多维表格
事件桥接补丁会验证版本；版本不一致时安装会停止，不会静默跳过日记事件。

升级 Feishu 插件后必须重新运行：

```bash
node /opt/autoboard/deploy/patch-feishu-events.mjs
systemctl restart autoboard-openclaw
```

## 运维

```bash
# 状态与端到端只读检查
/opt/autoboard/deploy/healthcheck.sh

# 本机状态备份
/opt/autoboard/deploy/backup.sh

# 服务日志
journalctl -u autoboard-openclaw -f

# 修复造成死信的原因后，把死信事件放回重试队列
runuser -u autoboard -- env \
  HOME=/var/lib/autoboard \
  OPENCLAW_HOME=/var/lib/autoboard \
  OPENCLAW_STATE_DIR=/var/lib/autoboard/.openclaw \
  OPENCLAW_CONFIG_PATH=/var/lib/autoboard/.openclaw/openclaw.json \
  node /opt/autoboard/scripts/task-journal.mjs retry-dead-letters
```

```bash
# 财务风控结构、看板和仪表盘状态
runuser -u autoboard -- env \
  HOME=/var/lib/autoboard \
  OPENCLAW_HOME=/var/lib/autoboard \
  OPENCLAW_STATE_DIR=/var/lib/autoboard/.openclaw \
  OPENCLAW_CONFIG_PATH=/var/lib/autoboard/.openclaw/openclaw.json \
  AUTOBOARD_STATE_DIR=/var/lib/autoboard/.openclaw/workspace/state \
  node /opt/autoboard/scripts/financial-control.mjs status

# 手工触发重新汇总和风险核对（沿用上面的 runuser/env 环境）
runuser -u autoboard -- env \
  HOME=/var/lib/autoboard \
  OPENCLAW_HOME=/var/lib/autoboard \
  OPENCLAW_STATE_DIR=/var/lib/autoboard/.openclaw \
  OPENCLAW_CONFIG_PATH=/var/lib/autoboard/.openclaw/openclaw.json \
  AUTOBOARD_STATE_DIR=/var/lib/autoboard/.openclaw/workspace/state \
  node /opt/autoboard/scripts/financial-control.mjs sync
```

风控规则配置中的 80% 和 90% 预算承诺占用阈值默认标记为“暂定”。
取得单位正式制度和审批权限表后，应在规则配置表中复核并改为正式阈值。
两条规则可以分别启停。

飞书 App Secret、模型 API Key 和 Gateway Token 不包含在部署包中。

财务明细由 `AUTOBOARD_FINANCE_RECIPIENT_ALLOWLIST` 限制到明确授权的
飞书用户或会话；未授权会话不能调用财务多维表格工具。AI 只能创建
“AI草稿”或“待人工复核”记录，不能通过机器人工具把记录改成“人工已确认”。
