# agent 本地配置提示词 · v2.2

网页“复制给 agent 的配置提示词”复制以下内容，不读取个人配置。先在学校确认个人 API 使用许可；需要已有 Python 3.8+ 环境。云端 agent 的数据边界需单独确认。

```text
请协助我在本机配置 Canvas Weekly Hub v2.2 的 Python 路线。
1. 先读取 README.md、docs/部署指南.md、config/canvas_config.example.json、canvas_weekly_report.py 和 serve_board.py，按实际实现操作。先确认学校允许个人 API 使用；此项目使用手动令牌，不能据此认定是学校批准的应用。
2. 优先使用已有 Python 3.8+ 环境；引擎仅用标准库。安装软件或依赖前征求同意。不要把 agent 路线描述成无需运行环境。
3. 复制配置示例为本地 canvas_config.json，让我自己在本地填写学校 Canvas 地址与 Token，不要求把真实 Token 粘贴进聊天或提示词。不要读取或输出 Token 到聊天、日志、截图或 Git 提交；排错只展示脱敏信息。
4. 保持 github.push_enabled=false，不自动上传课程数据，不自动 commit、push 或部署云端资源。
5. 用选定的 Python 解释器先执行 canvas_weekly_report.py --check-config；该检查仅验证配置格式，不证明令牌或课程权限有效。通过后再运行 canvas_weekly_report.py，依据真实输出汇报，不编造课程内容。
6. 成功后打开生成的“我的学习网站.html”离线快照，或用同一解释器运行 serve_board.py，访问 http://localhost:8137/。默认配置与产物在项目目录；设置 CANVAS_HUB_DATA_DIR 后使用该目录。
7. 如需自动更新，配置本机 agent 或系统计划任务定时运行引擎，电脑与运行环境需要在线。本地 Python 直接查询学校，不需要 Cloudflare、KV 或云端定时器。
8. 若你是云端 agent，请在读取配置或课程产物前说明：输入的凭证、读取的课程内容可能进入模型服务商，不能宣称全程只在本机处理。优先让我自行填 Token 并运行，只提供脱敏的报错。
```

在本地自行填写 Token，不要把填好凭证的文件或课程产物贴到聊天。操作细节见 [本地部署指南](部署指南.md)。首次设置选择“升级版”可查看并复制上述提示词；个人 Worker 须更新本次完整代码。
