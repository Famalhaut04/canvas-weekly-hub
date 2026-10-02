# Canvas Weekly Hub · v2.2

把 Canvas 的作业截止、提交状态、新课件、公告和变化集中到一个学习看板。默认香港城市大学，其他 Canvas 学校可在高级设置修改地址。

## 系统概述

数据流程：**你的浏览器 → 你自己的 Cloudflare Worker → 学校 Canvas → 浏览器整理、显示并保存**。数据不经过作者服务器。

| 部分 | 功能 |
|---|---|
| Canvas + 令牌 | 提供课程数据；项目只调用查询接口，不提交作业或修改课程 |
| 个人 Worker | 同时提供网页和查询代理，自动识别代理地址；不持久保存令牌或课程数据 |
| 浏览器处理 | 筛选近期动态，比较快照，发现改期、新评分和移除 |
| 学习看板 | 待办倒计时、课程动态、历史切换、跨周搜索、深色模式 |
| 本机存储与导出 | 保存当前浏览器的配置与历史；导出离线 HTML、日历 ICS 和不含凭证的 JSON 备份 |
| Python / agent（可选） | Python 直接访问 Canvas，生成周报、看板、日历，按需下载课件；agent 或计划任务负责运行 |

看板由你手动刷新。**v2.2 暂停云端订阅和微信推送，不需要 KV、定时器或 SendKey。** 完整说明见 [系统概述](docs/系统概述.md) 或 [网页说明](https://famalhaut04.github.io/canvas-weekly-hub/web/overview.html)。

## 基础版：部署一次，填令牌即用

**[打开项目入口](https://famalhaut04.github.io/canvas-weekly-hub/web/)**

先确认学校允许个人 API 使用。本项目使用手动令牌，不代表校方批准的应用；[Canvas 官方要求面向其他用户的应用使用 OAuth](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth)，个人自部署适用范围需向学校确认。

1. 创建自己的助手：一键部署，或用邮箱登录 Cloudflare 后复制部署代码。
2. 从 Worker 概览 / Domains & Routes 打开自己的正式网址，看到“连接你的 Canvas”；不用编辑器预览网址。
3. 粘贴自己的 Canvas 令牌，点击“连接并生成看板”。

| 创建方式 | 需要什么 | 操作 |
|---|---|---|
| [一键部署](https://deploy.workers.cloudflare.com/?url=https://github.com/Famalhaut04/canvas-weekly-hub) | Cloudflare + GitHub 账号 | 授权、部署，打开自己的网址 |
| 仅邮箱方式 | Cloudflare 账号 | 复制部署代码 → Worker 编辑器全选替换 → Deploy |

主流程只填令牌；其他学校、到期日按需展开。助手的到期日是选填提醒，学校生成页可能必填；“仅检查连接”验证身份，不证明课程权限。教程：[零基础部署](docs/Cloudflare部署图文教程.md) · [使用指南](docs/网页版使用指南.md)。若网络无法访问自己的 `workers.dev` 网址，请确认网络可达或使用自己绑定的可达域名。

## 升级版：本地运行

首次配置选择“升级版”，可展开本地 Python / agent 步骤并复制不含凭证的提示词；“基础版”提供网页部署路线。

获取当前源码可克隆 main，或下载 [v2.2 更新源码包](https://github.com/Famalhaut04/canvas-weekly-hub/releases/download/v2.2/canvas-weekly-hub-v2.2-source.zip)。Release 自带的 Source code (zip / tar.gz) 对应保留的历史标签，不包含本次同版本更新；请选择上述附件。

下载或克隆仓库，复制 `config/canvas_config.example.json` 为 `canvas_config.json`，在本地填写学校地址和令牌，不把 Token 粘贴进聊天。需要已有 Python 3.8+，仅依赖标准库。

```bash
python canvas_weekly_report.py --check-config
python canvas_weekly_report.py
python serve_board.py
```

在项目目录用同一个解释器执行。第一条只检查配置格式，不验证学校权限；第二条生成周报、看板、ICS，并按配置下载课件；第三条提供 `http://localhost:8137/` 与页内刷新。也可以双击生成的“我的学习网站.html”快照，离线文件不会自动抓取。

本地 Python 不需要 Cloudflare、KV 或云端定时器。agent 或计划任务可定时运行，电脑、运行环境和网络需要在线。保持 github.push_enabled=false；云端 agent 读取课程内容或凭证可能将它们发送给模型服务商，不能承诺全程本机处理。详见 [本地部署指南](docs/部署指南.md) 和 [可复制提示词](docs/1002_agent本地配置提示词_v1.md)。

## 旧用户升级

- 更新自己的 Worker：手动部署用户复制新的 `worker.js` 全选替换并 Deploy；GitHub 部署用户同步更新。已部署实例不会因本仓库发布自动升级。
- 历史迁移：旧页面在“离线查看 / 旧版数据迁移”中备份，新网址导入，再填写令牌。导入会替换当前看板，建议先备份。
- 停用旧订阅：升级 Worker 后旧 Cron 不再执行抓取或推送；若原浏览器保留订阅密钥，可点“停用旧版云端订阅”移除旧配置和快照。也可在自己的 Cloudflare 删除旧 KV 配置、移除 Cron，并在 Canvas 撤销不用的令牌。清除本机数据不能撤销云端配置。
- 原公共入口仍支持使用自己的旧 Worker 查询课程，不自动清除浏览器历史。

停用旧订阅时需保留原 KV 绑定与原浏览器密钥，停用成功后再解绑；只删除该密钥的 cfg: / snap:，旧 KV 不会自动清空。不同设备、浏览器、网址的历史不自动同步。更早旧版不一定有 JSON 备份按钮，不能承诺直接迁移。

## 主要文件

| 文件 | 作用 |
|---|---|
| `worker.js` | 可直接部署的完整包：网页、代理、系统概述和离线模板 |
| `worker/runtime.js` | Worker 源码 |
| `web/overrides.js`、`site-template/index.html` | 配置、抓取、导出与看板模板 |
| `web/build_web.py` | 运行 `python web/build_web.py` 生成网页与部署包 |
| `web/overview.html` | 面向用户的系统概述 |
| `canvas_weekly_report.py`、`serve_board.py` | 本地引擎和看板服务 |

## 数据与隐私

令牌与课程数据保存在当前浏览器；查询经过自己的 Worker 和学校 Canvas，Cloudflare 作为托管商会处理这些请求。作者没有接收数据的后端。不要在他人部署的网址填写令牌；令牌是账号凭证，不是可公开的只读密码。

无课程数据遥测，不默认启用 Worker 请求日志；代理只允许课程查询接口，不跟随携带令牌的重定向，敏感响应不缓存。星数展示会请求 GitHub 公共 API，**不携带 Canvas 令牌或课程数据**。导出的看板、日历与备份含个人课程信息，请妥善保管。

网页代码托管在 Worker，个人数据保存在浏览器，不能混为“看板全在云端”。离线 HTML 是导出时快照；JSON 排除配置凭证不代表匿名化。清除浏览器数据不撤销学校 Token 或清理旧云端凭证。

## v2.2 公告

网页与代理统一部署、令牌一键连接、可选项折叠、历史备份迁移、失败保护、手机布局与隐私改进。见 [简短公告](content/1002_v2.2更新公告_v1.md)、[GitHub Release](https://github.com/Famalhaut04/canvas-weekly-hub/releases/tag/v2.2)、[更新记录](CHANGELOG.md)。

2026-10-02 同版本更新：同步基础版 / 升级版入口、配置教程和 Release 的完整 worker.js 附件，并提供更新源码包；版本保持 v2.2，个人 Worker 仍需自行更新。发布前来源差异与待实测步骤见 [部署与令牌核对报告](docs/1002_部署与令牌配置核对_v1.md)，发布核验见 [同版本发布记录](docs/1002_v2.2同版本发布记录_v1.md)。

[工作原理](docs/工作原理.md) · [验证记录](docs/1002_v2.2一体化升级验收_v1.md) · [MIT 许可证](LICENSE)
