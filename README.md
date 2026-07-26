# AutoBoard

AutoBoard 是一套面向飞书多维表格和 OpenClaw 的任务督办、工作日记与财务风控工具。
它把自然语言笔记转换为可人工修订的任务或财务草稿，并通过确定性脚本完成进度留痕、
金额汇总和风险预警。

> 本仓库是脱敏后的开源发行版，不包含任何生产聊天、附件、凭据、服务器地址、
> 飞书资源 ID 或真实业务数据。

## 功能

- 任务主表、负责人协作看板、DDL 视图和任务总览
- 按天工作日记、看板变更自动留痕、手工备注和附件
- 负责人配置与个人看板同步
- 经济事项、预算、合同承诺、履约、发票、付款、风险和审计日志
- 预算占用、应付款、超预算和到期未付款等确定性规则
- AI 草稿与人工确认隔离：AI 不能把财务流水改为“人工已确认”
- 财务用户白名单和 OpenClaw 工具调用拦截
- 飞书事件实时触发以及定时补偿
- Ubuntu/systemd 部署、备份、迁移和健康检查

## 安全边界

- AI 负责理解和结构化输入，不负责认定会计、法律或审批合规性。
- 金额计算使用整数分逻辑，不由模型心算。
- 财务流水只有在授权人员于飞书表内改为“人工已确认”后才参与汇总。
- 80%/90% 阈值是可配置的管理提醒，默认不代表任何组织的正式制度。
- 不要把真实 `.env`、`openclaw.json`、聊天、附件、状态快照或备份提交到 Git。

## 架构

```text
飞书用户
  └─ OpenClaw + Feishu 插件
       ├─ 任务多维表格
       ├─ 按天工作日记
       ├─ 财务风控多维表格
       ├─ 事件桥接（实时）
       └─ 定时补偿（任务每小时、财务每15分钟）
```

任务与日记使用一个既有的飞书 Base；财务模块会通过 `setup` 创建独立 Base、
九张表、签前审查看板和仪表盘。

## 快速开始

### 1. 准备环境

- Ubuntu 24.04（部署脚本的目标系统）
- Node.js 24
- 飞书企业自建应用及多维表格权限
- OpenClaw `2026.7.1-2`
- `@openclaw/feishu` `2026.7.1`
- DeepSeek 或其他受 OpenClaw 支持的模型

先在飞书创建任务 Base 和任务主表，并按照
[任务主表字段说明](docs/TASK_SCHEMA.md)建立基础字段。记录 Base token 和 table ID。

### 2. 配置环境变量

```bash
cp deploy/autoboard.env.example deploy/autoboard.env.local
```

把所有 `replace_with_...` 值替换为自己的飞书资源 ID。不要提交
`deploy/autoboard.env.local`。

飞书 App ID、App Secret 和模型密钥存放在 OpenClaw 的受保护配置/凭据存储中，
不要写入本仓库或环境变量示例。

### 3. 初始化任务结构

先配置 OpenClaw 的飞书渠道，然后加载环境变量：

```bash
set -a
. deploy/autoboard.env.local
set +a

node scripts/migrate-minister-board.mjs
node scripts/migrate-minister-board.mjs --apply
node scripts/task-journal.mjs setup
node scripts/manage-board-owners.mjs sync
```

`migrate-minister-board.mjs` 默认只生成变更计划和备份；只有 `--apply` 才会修改飞书表。

### 4. 初始化财务模块

```bash
node scripts/financial-control.mjs setup
node scripts/financial-control.mjs configure-workspace
node scripts/financial-control.mjs self-test
```

首次 `setup` 会输出新财务 Base、表和看板 ID。将这些值填回运行环境，再配置飞书事件。

### 5. 构建服务器部署包

```bash
node scripts/build-deploy-bundle.mjs
```

随后参考 [服务器部署说明](deploy/README.md)。生产部署前应先阅读
[安全策略](SECURITY.md)，并在测试租户完成端到端验证。

## 测试

```bash
npm test
npm run check
npm run build
```

真实飞书端到端测试会临时写入并删除测试记录，只应在测试租户或明确授权的 Base 上运行：

```bash
node scripts/financial-control.mjs live-self-test
```

## 隐私

GitHub 仓库只保存程序代码和占位配置。真实聊天、图片、附件和飞书记录保留在部署者自己的
OpenClaw 与飞书环境中。部署者负责根据所在地区法律、单位制度和数据分类要求配置权限、
留存周期与跨境数据策略。

## License

[MIT](LICENSE)
