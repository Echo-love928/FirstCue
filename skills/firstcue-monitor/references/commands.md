# 命令与采集约定

入口：`python <skill>/scripts/firstcue.py`。下文省略入口。完整模式需要 Python 3.10+ 标准库，无需安装包。`add`、`update` 和 `config set` 的 JSON 输入都可以改用 `--file FILE`，避免 shell 引号问题。PowerShell 使用单引号包裹 JSON；不要在聊天中写真实密钥。

先执行 `doctor` 检查运行环境和配置标记。`doctor --network` 额外读取一个公开 RSS，不会使用付费 API、持久化业务状态或发送通知；单个端点可达不代表全部来源可用。`help` 输出完整命令，`--help` 显示标准 CLI 用法。

## 目标、来源、账号

```text
rules list
rules add --name "AI 编程" --query "AI coding agents" --kind topic
rules update --id ID --json '{"query":"Claude Code release","notify":true}'
rules pause --id ID
rules resume --id ID
rules delete --id ID
sources list
sources add --name "发布订阅" --kind rss --url https://example.com/feed.xml
sources add --name "发布页" --kind page --url https://example.com/news
sources pause --id bing
sources resume --id sogou
sources update --id ID --json '{"enabled":false}'
sources delete --id ID
accounts add --user-name AnthropicAI
accounts list
accounts pause --id ID
accounts resume --id ID
accounts delete --id ID
```

`rules add` 的 `--notify` 可显式开启通知资格，仍不直接发送。所有实体支持 `add --json OBJECT`，自定义实体支持 `update --id ID --json PATCH`。内置来源只能改名称和 enabled，不能删除或改端点；自定义源不因名称或 URL 被自动认定为官方。

X 账号通过高级搜索的 `from:用户名` 采集，无需额外账号解析 API。账号查询的返回材料交给宿主判断是否与目标有关。单次 `collect --query` 会同时读取已启用账号，结果可能包含与单次目标无关的材料。

## 采集、原文与查询

```text
collect --query "Claude Code new release" --source bing
collect --rule ID
collect --due
collect --hours 24 --out /absolute/path/collection.json
read --url https://example.com/news/release
evidence list --hours 120 --sort heat --limit 100
evidence list --unreviewed --offset 100
evidence list --source twitter --rule ID --search agent
evidence list --history --sort published
evidence list --audit
evidence show --id ID
```

- 单次查询不创建持久目标；不指定查询时采集已启用目标。`--due` 只检查至少 30 分钟未检查的目标，无到期目标时返回 skipped。首次运行从最近 120 小时建立数据，不发送历史通知。
- `--source ID` 限定一个启用来源。没有启用目标或匹配来源时明确报错。`--hours` 为 1–120；X 查询窗口固定至本轮起始时间，最多 3 页，有下一页时持久化游标，下轮续查。完成窗口回叠 10 分钟防延迟索引，URL 去重；过期窗口放弃。已完成 X 查询在缓存周期内不再计费请求。
- Bing、搜狗默认启用；百度、DuckDuckGo 默认暂停。公开搜索包含普通查询及 B站／微博站点定向查询，最多每轮 16 次；这是公开搜索发现，不是平台 API 或完整站内覆盖。能读取的视频／微博描述标记为 description，不能声称取得视频、字幕或完整帖子。
- 默认原文读取最多 10 次；X 外链原文也使用该预算。`read` 单次补证单独执行。所有网页为无登录 HTTP 请求，不执行 JavaScript，无法读取时保留错误与已有材料，不伪造全文。
- 订阅源面向所选范围提供候选，并不进行脚本级语义匹配；`ruleIds` 与 `queries` 都是发现范围提示，宿主必须检查型号、版本、动作等限制。
- 证据以规范 URL 去重，保留 firstDiscoveredAt，不用 updatedAt、抓取或再发现刷新旧闻。无发布日期时明确使用首次发现时间，无法证明事件新近发生。正文最多 12000 字符，超出部分未进入模型证据。
- X 回复、引用、转发和未知类型只进入审计；纯原创没有互动数值展示门槛。缺失指标保持缺失。蓝标仅保留为资料，不作为官方或真实依据。
- 默认查询按真实互动指数取前 100 条，权重为点赞 1、转发 2、评论 1、浏览 .01、书签／收藏／投币 2、弹幕 1、评分 1；这是跨平台启发式排序，不能视为相同受众规模。published/discovered 只在这批结果内重排，`--offset` 可继续处理其他材料；`--history` 仅回看已保存材料。

状态：success／empty／cached／unconfigured／limited／partial／failed。整个运行包含各来源状态，API 拒绝、验证码、解析结构改变、网络或额度失败不会当作 empty。collect 的 failed 返回非零退出码；partial 仍返回 JSON 供宿主处理可用材料。read 失败返回非零，不修改已有证据。

## 设置与用量

```text
config show
config set --json '{"searchPerRunLimit":12,"readPerRunLimit":8,"xDailyLimit":100}'
status
```

| 设置 | 默认 | 范围 |
| --- | --- | --- |
| lookbackHours | 120 | 1–120 |
| searchPerRunLimit | 16 | 1–20 |
| readPerRunLimit | 10 | 0–30 |
| xPagesPerQuery | 3 | 1–3 |
| xDailyLimit | 200 | 1–10000 |
| xResultDailyLimit | 2000 | 20–100000 |
| cacheMinutes | 30 | 1–1440 |
| intervalMinutes | 30 | 固定 |

X 请求尝试与返回条数按北京时间日历日计数，失败请求同样占用本地请求预算；本地计数不是供应商账单。下一页需要至少 20 条剩余预算；供应商超量返回会拒绝本页并保留窗口。公开请求与 X 同域至少间隔 2 秒，429／503 的 Retry-After 持久化，默认退避 60 秒。每次成功采集后保存，不能通过进程重启清空预算。`--refresh` 只绕过公开采集／原文缓存，不绕过 X 周期、配额、来源退避或锁。

## 报告与通知

```text
reports record --file /absolute/path/analysis.json
reports list
reports show --id ID
reports render --id ID --out /absolute/path/digest.md
notify preview --report ID --channel mail
notify send --report ID --channel mail
notify preview --report ID --channel feishu
notify send --report ID --channel feishu
notifications list
notifications show --id ID
notify retry --id ID
```

分析格式见 [analysis.md](analysis.md)。发送必须来自用户授权，脚本不会自动判断授权。只有 direct、未被 refuted、120 小时内、证据未变化的事件参与；持久目标至少有一个仍启用且 notify=true。无持久目标的单次报告可按用户明确指令发送。暂停、失效、已排队和已发送内容不重复进入汇总。

每个渠道分别去重、冷却 30 分钟，同一正文的原文 URL 集合用于跨报告去重。一个原文承载多个新事件时可能被保守去重，不能保证识别文章后续追加更新。邮箱保存完整文字；飞书用纯文本富文本节点避免来源内容形成群提及，超 18 KB 拒绝发送，需由宿主另存较短报告后发送，不静默截断。

发送前持久化 sending，成功为 accepted，不保证用户已读。明确被拒绝时为 failed，可按用户要求重试，最多四次且仍等 30 分钟。超时或结果无法确认时为 uncertain；中断留下 sending，同样需要用户核对实际收件，不能自动重发。更换目的地后旧任务不能重试；两渠道独立，不安排自动重试或常驻发送器。SMTP 成功收件、X 余额与可用网络必须在用户实际环境单独验收。

## 接口依据

2026-10-19 开发核对：

- [TwitterAPI.io 高级搜索](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search)：X-API-Key、Latest、since_time／until_time、cursor 与 has_next_page。
- [Python http.client](https://docs.python.org/3/library/http.client.html)：HTTPS、证书校验、CONNECT 代理与响应读取。
- [Python html.parser](https://docs.python.org/3/library/html.parser.html)：HTMLParser 流式解析与实体处理；内置解析器有深度及节点数量上限。
- [Python smtplib](https://docs.python.org/3/library/smtplib.html)：SMTP_SSL、强制 STARTTLS、认证及发送状态；邮件只用内存中的纯文本，不读取附件或远程内容。
- [飞书自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)：Webhook、签名与正文大小。签名使用 timestamp + 换行 + secret 作 HMAC key，对空正文摘要后 Base64。

搜索引擎的 HTML 没有稳定 API 合约，解析器是当前支持范围；遇结构变化应报告失败并维护解析器，而非宣称稳定或全量覆盖。
