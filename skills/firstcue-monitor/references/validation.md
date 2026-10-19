# 验证记录

验证日期：2026-10-19；FirstCue Skill v2.0.0，Python 3.14.3，Windows。代码使用 Python 3.10+ API，本机实际运行版本为 3.14.3。

- 技能独立测试：34 项通过。覆盖 RSS／Atom、四种搜索解析、原文类型、X 分类与增量分页、预算、锁与原子存储、URL 去重、旧闻退出、证据引用、目标变更后结论失效、通知预览／去重／间隔／不确定送达，以及 SMTP TLS 与稳定消息 ID。
- 可搬移验证：只复制 Python 源码到项目外的临时目录，用 `python -I -S -B` 实际执行环境检查、创建／修改／暂停目标、配置、账号、到期采集、报告导入／导出及通知预览。不加载 user site、site-packages 或 PYTHONPATH，不需要 pip、npm 或原项目；启动工作目录中的 `.env` 不会被加载。
- 依赖检查：逐个检查脚本导入，均为 Python 标准库或随包模块。Node 脚本、package.json、lockfile、node_modules 和 npm 缓存已从技能源码目录移除。
- v1 兼容：用旧 Node 实现生成的固定假数据状态验证证据哈希、规则指纹和报告结论仍有效，不在测试时调用 Node。没有迁移、读取或改动原项目 SQLite。
- 技能 frontmatter 通过 skill-creator 的 quick_validate；全部 Python 模块可被标准库解析并由测试导入。
- 原项目 196 项测试通过，`npm run check` 通过；Git 确认原有跟踪文件没有改动，新增文件全部位于 `skills/`。
- 真实公开 RSS：Python 标准库客户端从 OpenAI feed 解析 100 条材料，其中本次近 120 小时范围内 8 条。一篇原文读取遇到连接重置，保留订阅材料并记录 readError，未声称取得全文。
- 真实公开搜索：Bing 单次查询解析 7 条自然结果；一次原文读取返回 HTTP 403，保留 snippet 和读取错误。结果是否与目标直接相关仍交给宿主 AI 判断。

真实网络检查仅使用内存状态，未配置或调用付费 X、模型 API、SMTP 或飞书，未修改现有监控数据。X API 和通知发送仅使用隔离替身验证；真实余额、账号权限、收件与宿主定时能力需要在实际使用环境配置后验收。没有自动安装技能到宿主，也没有创建定时任务。

复验命令：

```text
python -S -B -m unittest discover -s <skill>/tests -p "test_*.py" -v
python <skill>/scripts/live_smoke.py --source openai
python <skill>/scripts/live_smoke.py --source bing
```

测试默认使用系统临时目录。受限环境可以将 `FIRSTCUE_TEST_TMP` 指向一个明确可写的临时父目录；测试仅清理自己创建的随机子目录。
