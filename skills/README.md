# FirstCue Agent Skills

`firstcue-monitor/` 是可单独复制的热点监控技能，适用于支持技能说明和脚本执行的宿主 AI。v2 内置 Python 标准库脚本，无需 pip、Node.js、npm、后端服务或模型 API。宿主 AI 自身负责分析。

拿到技能文件夹后，直接让 AI：

> 请读取技能目录中的 SKILL.md，帮我查找最近 24 小时的 AI 编程热点，核对原始证据并生成中文报告。

完整模式需要 Python 3.10+；没有 Python 时，具备搜索／网页工具的宿主可以执行有限的一次性检索。没有联网和脚本工具的纯聊天环境无法保证运行。首次检查与脚本调用示例：

```text
python skills/firstcue-monitor/scripts/firstcue.py doctor
python skills/firstcue-monitor/scripts/firstcue.py collect --query "AI coding agents" --hours 24
```

可用 `python3` 或 Windows 的 `py -3` 替代 `python`。不需要安装命令；把整个技能目录复制到项目外同样可以使用。

公开搜索、RSS 和网页无需 Key；X 与通知可选配置。数据默认保存在技能自己的 `.firstcue/`；密钥只从技能自己的 `.env`、显式指定的环境文件或进程环境取得。技能不会自动安装到宿主、创建定时任务或发送消息。持续监控需要宿主定时唤醒 AI。

[技能入口](firstcue-monitor/SKILL.md) · [配置说明](firstcue-monitor/references/setup.md) · [验证记录](firstcue-monitor/references/validation.md)

对外分发使用 `releases/firstcue-monitor-v2.0.0.zip`。旧 v1 ZIP 仅作为此前交付记录；新用户应使用 v2。
