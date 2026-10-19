# 复制即用与独立配置

整个 `firstcue-monitor/` 都是技能包，可复制到任意独立目录。按宿主的技能加载方式注册该目录，或直接让宿主读取其中 `SKILL.md` 并执行脚本。核心指令、JSON 协议与脚本不依赖任何宿主专用工具；`agents/openai.yaml` 仅是可忽略的界面元信息。

## 首次使用

完整脚本模式仅需 Python 3.10 或更新版本的标准库，不需要 pip、虚拟环境、Node.js、npm 或任何第三方包。命令中的 `<skill>` 替换为实际绝对目录；路径含空格时加引号。可用 `python3` 或 Windows 的 `py -3` 替代 `python`。

```text
python <skill>/scripts/firstcue.py doctor
python <skill>/scripts/firstcue.py collect --query "AI coding agents"
```

直接让 AI 读取技能目录中的 `SKILL.md` 并提出关注目标即可。`doctor` 不联网也不创建状态；`doctor --network` 可额外验证一个公开 RSS 入口是否可达。首次保存目标或采集时自动创建技能的数据目录，无需手动初始化。

没有 Python、但宿主提供搜索／网页工具时，可以按 [fallback.md](fallback.md) 执行一次性检索。完整持久化、X API、预算与通知能力需要 Python；不能把 Python 描述成完整模式的可选依赖。普通纯聊天窗口也不能保证运行。

不要在原项目安装依赖、改配置、导入 server/shared 或启动服务。验证命令：`python -S -B -m unittest discover -s <skill>/tests -p "test_*.py" -v`；`-S` 禁用第三方 site-packages，验证标准库独立性。

可选真实网络检查：`python <skill>/scripts/live_smoke.py --source openai`（或 bing／sogou）。只读取一个公开来源，最多补读一篇原文；不读取环境文件、不用付费 API、不保存状态、不发送通知。失败会明确返回来源错误，不保证每个网络环境可达。

本次交付验证范围与真实网络限制见 [validation.md](validation.md)。

## 密钥

仅当技能自己的 `.env` 尚不存在时，将同目录 `.env.example` 复制为 `.env`，填写所需项。不要覆盖已有文件，也不要自动读取原项目 `.env`。CLI 从脚本目录定位环境文件，与启动时的工作目录无关；`--env-file PATH` 可指定另一个明确授权的文件，进程环境同名变量优先。

| 配置 | 用途 |
| --- | --- |
| TWITTERAPI_IO_KEY | TwitterAPI.io；缺少时明确记录未配置，其他来源继续 |
| HTTPS_PROXY / HTTP_PROXY | 可选 http:// 代理地址；HTTPS 目标通过 CONNECT 并校验证书。代理需被信任，目标解析由代理决定；不支持 SOCKS 或 https:// 代理端点 |
| SMTP_HOST / SMTP_PORT | 可选邮件通知，端口默认 587 |
| SMTP_SECURE | 465 使用 true；587 使用 false 并强制 STARTTLS |
| SMTP_USER / SMTP_PASS / SMTP_FROM | SMTP 账号、授权码、发件人 |
| NOTIFY_EMAIL | 一个接收邮箱 |
| FEISHU_WEBHOOK_URL | 飞书国内版自定义机器人地址 |
| FEISHU_SIGNING_SECRET | 机器人启用签名时填写 |

公开搜索、RSS 和网页不需要新 Key。没有任何模型凭据字段。只返回配置状态，不展示密钥；不要把密钥放进命令参数、报告、版本库或聊天。

## 数据与隔离

默认数据位于 `<skill>/.firstcue/state.json`，包含目标、来源、X 账号、证据、分析报告、缓存、游标、限额、运行及通知记录。不接触原项目 `data/` 或 SQLite。缓存、凭据和 Python 缓存由技能自己的 `.gitignore` 排除。

`--data-dir PATH` 可为不同用户或主题指定独立数据目录；每次调用必须使用同一目录才能延续增量和去重。运行时先锁定该目录，所有更改原子替换状态文件。锁忙时停止，不并发覆盖状态。异常退出可能留下 `.lock`：确认锁文件记录的进程已退出后，由操作者删除这个精确锁文件，再继续，不能自动抢锁。

备份时等待当前命令结束，再复制整个数据目录。JSON 存储面向个人规模，不建议多个机器共享同一网络文件目录。不会自动删除历史证据；长期运行需自行归档整个数据目录。

把技能复制到其他机器时，只复制技能文件夹即可；凭据和历史状态应单独按需迁移，公开分发包不会包含它们。v2 保留 v1 的 JSON 状态结构与指纹协议，可以继续使用已有技能的 `.firstcue/` 或同一个 `--data-dir`；不自动读取原网页项目数据。升级前等待运行任务结束并备份技能数据，更新源码后运行 `doctor`。

## 分发

使用交付的 `firstcue-monitor-v2.0.0.zip`，或运行 `python <skill>/scripts/package_skill.py --out ZIP路径` 生成源码包。打包器按源码白名单选择文件，不包含 `.env`、历史状态、Python 缓存或依赖目录，且拒绝覆盖已有 ZIP。收件人解压后直接让宿主读取 `SKILL.md`，无需安装包。
