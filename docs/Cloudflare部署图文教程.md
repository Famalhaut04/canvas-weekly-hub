# 零基础部署教程 · v2.2

网页与代理一起放在**你自己的 Cloudflare 账号**。电脑和手机用浏览器访问；不需要 agent、Python、KV、Cron 或 SendKey。首次成功后仍需手动刷新。

## 开始前

- 准备邮箱和可登录的 Cloudflare 账号，完成邮箱验证；普通部署无需购买域名。免费账户也有额度限制，以控制台提示为准。
- 一键路线还需要 GitHub 账号，并授权 Cloudflare 创建 / 读取自己的项目仓库；复制代码路线不需要 GitHub 账号。
- 确认网络能访问 Cloudflare 控制台、个人 Worker 正式网址和学校 Canvas。
- 确认学校允许个人 API 使用，且账号有生成令牌与读取课程的权限。本项目使用手动令牌，不代表学校已批准此应用。[Canvas 官方要求面向其他用户的应用使用 OAuth](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth)；个人自部署是否允许，应向学校确认，不能把自部署视为自动豁免。
- 当前核对依据代码和官方资料，**未使用真实账号完成 Cloudflare 创建、授权及城大令牌生成**，这些步骤待实测。

## 从哪里开始

打开 [公共项目入口](https://famalhaut04.github.io/canvas-weekly-hub/web/)，选择“基础版”。在这里创建自己的助手，**不要在作者公共入口或他人实例填写个人 Token**。部署后只在自己的正式网址填写。

| 创建方式 | 条件 |
|---|---|
| 一键创建 | Cloudflare + GitHub 账号，接受仓库授权 |
| 仅邮箱复制代码 | 已验证邮箱的 Cloudflare 账号，不需要 GitHub |

有 agent 经验可选“升级版”，查看本地 Python / agent 配置方式，见 [本地指南](部署指南.md)。这是另一条运行路线，不是省略运行环境。

## 方式一：一键部署

1. 点击 [一键创建](https://deploy.workers.cloudflare.com/?url=https://github.com/Famalhaut04/canvas-weekly-hub)。
2. 登录自己的 Cloudflare、GitHub；阅读授权范围，按引导将项目复制到**自己的仓库**并部署到自己的 Cloudflare 账号，不修改作者仓库。
3. 若询问项目设置：项目根目录使用仓库根；本项目没有 npm 构建步骤，构建命令留空，部署命令使用平台默认的 `npx wrangler deploy`；入口由根目录 `wrangler.toml` 指向完整 `worker.js`。不要改成 `web/` 或 `worker/`。按实际控制台确认设置；若更改 Worker 名称，须与 `wrangler.toml` 的 `name` 一致。
4. 等待部署成功，查看部署记录而不是仅仓库创建成功。这里不需要填写 Canvas Token、SendKey、KV 或 Cron。
5. 从 Worker 概览或 **Settings → Domains & Routes** 找到正式生产网址，打开并收藏。

**成功标志：**自己的正式网址出现“连接你的 Canvas · v2.2”，并提供令牌输入框。不应仍是公共引导页或 Hello World。网页自动识别本站 Worker，不需要再次填代理地址。

一键按钮会创建自己的仓库并接入 Workers Builds；详见 [官方部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/) 和 [构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/)。本项目文件已构建，控制台流程仍需真实账号实测。

## 方式二：仅邮箱，复制完整代码

1. 在 [Cloudflare 注册页](https://dash.cloudflare.com/sign-up) 注册、验证邮箱并登录。
2. 控制台选择 **Workers & Pages → Create application / Create → Hello World**（部分界面名为 Start with Hello World），输入 Worker 名称并 **Deploy**。若入口名称不同，参照 [官方控制台指南](https://developers.cloudflare.com/workers/get-started/dashboard/)；Hello World → Deploy → Edit code 路线也见 [官方部署教程](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)。
3. 返回公共项目入口，展开“只有邮箱？按这 3 步创建”，点击“复制部署代码”。复制的必须是**完整 `worker.js`**：文件开头有“自动生成”，包含 `const HUB_PAGES` 及末尾的 Worker 运行逻辑。**不要复制 `worker/runtime.js`、文档中的片段或 GitHub 网页的 HTML。**
4. 返回自己的 Worker → **Edit code**，在代码编辑区域全选，替换 Hello World。不要粘贴到终端、环境变量或预览窗口。
5. 点击 **Deploy** 并等待成功提示；仅保存代码或右侧预览成功不代表生产部署完成。语法错误先确认完整复制、未截断。
6. 返回概览 / Domains & Routes，打开自己的正式生产网址并收藏。看到“连接你的 Canvas · v2.2”才完成部署。

复制被浏览器拒绝时会下载代码文件；也可点击“下载部署代码”，用文本编辑器打开后全选复制。不需要编辑 Token 或任何个人信息到 Worker 源码。

## 正式网址、预览网址与代码版本

- 使用控制台生产域名，通常为 `https://<worker-name>.<account-subdomain>.workers.dev/` 或自己绑定的域名。
- 不收藏编辑器预览、带版本前缀或别名的预览链接。预览地址的行为及版本可能不同；换网址也会换一套浏览器存储。参见 [官方版本网址说明](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)。
- v2.2 是版本名，不保证所有历史下载文件相同。2026-10-02 同版本更新同步公共入口、完整 worker.js 附件和基础版 / 升级版按钮；以前下载的旧包与个人实例不会自动更新。
- 使用公共入口配套代码或 Release 的最新 worker.js 附件。本地 Python 用户下载附件 [canvas-weekly-hub-v2.2-source.zip](https://github.com/Famalhaut04/canvas-weekly-hub/releases/download/v2.2/canvas-weekly-hub-v2.2-source.zip)，或克隆 main。GitHub 自带的 Source code (zip / tar.gz) 仍对应历史 v2.2 标签，不含同版本更新。源码包与部署包对应的提交见 [发布记录](1002_v2.2同版本发布记录_v1.md)，发布前差异见 [核对报告](1002_部署与令牌配置核对_v1.md)。

## 连接 Canvas：部署与认证是两步

1. 保持自己的助手页面打开。城大用户点击“登录城大 Canvas”，打开 [学校入口](https://canvas.cityu.edu.hk/) 并完成学校 SSO；不要复制临时认证跳转链接作为学校地址。
2. 在学校 Canvas 打开 **账户 / Account → 设置 / Settings → 新访问令牌 / New Access Token**。看不到或按钮禁用，先联系学校确认 API 权限。
3. 填写用途（例如个人学习看板），按**学校生成页**要求填写到期日，再点 Generate Token。
4. **按只显示一次处理**：生成后立即复制并安全保管，返回自己的助手粘贴。官方 API 文档说手动令牌生成后不能重看；最新用户指南同时介绍详情和再生入口，因此不能保证所有学校界面一致。不要依赖日后能否再次查看完整值；丢失时按学校提供的再生 / 创建功能更换。
5. 默认城大。其他学校先展开“其他学校 / 到期日 / 连接检查”，填写自己的 Canvas **HTTPS 域名**（不含端口、路径、账号、参数），帮助链接会改成该站点的 `/profile/settings`；到该校生成令牌，不能使用城大令牌。
6. 助手的“令牌到期日”是**选填的提醒日期**，不会延长或设定学校令牌期限。Canvas 生成页可能必填；官方当前说明针对学生列出必填期限限制，城大具体政策待实测，不写死 90 天或永久有效。
7. 点击“连接并生成看板”：程序先验证 Worker、用户身份，再读取活跃课程及作业。看到自己的课程看板才代表这次主流程完成。没有活跃课程时可以生成空看板，应再到学校核对选课状态。
8. “仅检查连接”只验证身份并保存配置，**不读取课程**，不能作为课程权限通过的证明。课件或公告部分失败时会保留警告并生成其余可用内容；课程 / 作业关键请求失败时不覆盖旧配置、看板和快照。

令牌到期或收到 401 时：回学校设置创建 / 再生令牌 → 在自己的助手设置替换 Token 和提醒日期 → 点击“连接并生成看板” → 确认成功后撤销不用的旧令牌。程序只调用查询接口，**Token 本身的权限可能允许其他操作，并非只能读取**。令牌生成、期限及权限说明见 [Canvas 官方用户指南](https://community.instructure.com/en/kb/articles/662901-how-do-i-manage-api-access-tokens-in-my-user-account)。

## 旧用户升级、迁移及停用提醒

- 已部署个人实例不会因作者发布自动升级。手动路线重新复制完整代码并 Deploy；GitHub 路线更新自己的仓库并确认 Cloudflare 生产部署成功，不能只更新作者页面。
- 同一网址、同一浏览器升级一般仍读原存储；换网址 / 设备 / 浏览器则先在旧入口备份 JSON，到新入口导入并重新填 Token。导入替换当前历史，先备份。学校地址必须一致。
- 旧版本不一定提供 JSON 备份按钮；不能看到该按钮时，不承诺自动迁移，先保留旧实例和浏览器数据，再升级仍可访问旧存储的页面后尝试导出。

若启用过旧云端订阅：

1. 先升级**原 Worker**。新版 scheduled 不再抓取或推送，/setup 和 /ics 返回暂停提示；其他旧 Worker 不会随之停用。
2. 原浏览器保留订阅密钥、原 Worker 仍绑定原 KV 时，点击“停用旧版云端订阅”，确认成功后再解绑 KV。该按钮只删除对应密钥的 cfg: / snap:，不清空整个 KV，也不自动移除 Cron。
3. 没有密钥、换网址或已经解绑时，到自己的 Cloudflare 手动处理原 KV 的 cfg: / snap:；旧错误记录与其他密钥项也不会自动删除。按自己的资源情况移除旧 Cron；不用的 KV 再自行解绑 / 清理。
4. 到学校撤销不用的 Token，移除日历 App 中旧云端订阅及缓存事件。**清除浏览器数据不等于撤销学校 Token 或清理云端凭证。**

v2.2 新部署不创建 KV、Cron 或 SendKey；旧 KV 不会自动清空。

## 排错：先确定失败在哪一步

| 发生在哪一步 | 看到什么 | 如何判断原因 | 下一步 |
|---|---|---|---|
| 打开正式 Worker | 网页打不开 / DNS 或网络错误 | 对照控制台生产域名、部署状态，区分网址拼错与网络不可达；还未使用 Token | 重开生产网址，检查网络；使用已有可达自有域名，不反复换 Token |
| 替换代码后打开 | Hello World | 仍是默认代码、未 Deploy 或打开了旧版本网址 | Edit code 全选粘贴完整 worker.js → Deploy → 从概览打开生产网址 |
| 部署或检查 Worker | 语法错误 / 不是本项目代码 | 检查是否完整包，是否误复制 runtime.js / HTML / 片段；检查生产部署记录 | 重新下载配套完整 worker.js 全选替换，不手工拼片段 |
| Worker 在线后验证身份 | “令牌无效或已过期（HTTP 401）” | Worker 健康检查通过不代表 Token 有效；确认 Token 与学校地址配对 | 到对应学校更换 Token；在自己的助手替换，检查实际到期日 |
| Canvas 身份 / 课程查询 | HTTP 403 | 账号 / 课程权限或学校云端访问策略；不是“Worker 网址错” | 在学校网页核对课程，向学校确认 API / Cloudflare 访问许可；本地路线仅在许可且网络可达时尝试 |
| Worker 健康检查 | Worker 服务 HTTP 错误 / Access 登录页 | 先查 Cloudflare 服务、部署或访问保护，尚未验证学校 Token | 解决 Worker 服务问题；不要把 Cloudflare 401 / 403 当学校令牌错误 |
| 抓取课程 | 超时 / 关键作业查询失败 | 请求超时、学校接口不可用；本次未更新 | 保留旧数据，稍后单次重试；查看错误对应的课程 / 请求，别并行点击 |
| 生成看板 | “部分内容未能读取” | 文件 / 公告查询失败；空列表不证明没有内容 | 阅读警告，到学校确认，再刷新；其他成功数据本次会保存 |
| 保存配置 / 看板 | 浏览器无法保存 | 存储被禁用、配额或隐私模式限制，不能当成已保存 | 允许本站存储、备份已有内容，再在可信浏览器重试；存储回滚是尽力处理，不保证故障下原子保存 |
| 按教程找按钮 | v2.2 但没有登录 / 升级版按钮 | 下载了旧包、历史标签源码或个人实例未更新 | 重新下载当前完整 worker.js 并更新个人实例；本地路线用更新源码包或 main，不能只比较版本名 |

## 数据保存在哪里

网页程序托管在自己的 Worker；Token、配置、课程看板与快照由程序保存在**当前浏览器**。查询可经过自己的 Cloudflare，但不经过作者服务器、不上传作者仓库。当前程序不把凭证存进 KV；历史云端数据需单独清理。

GitHub 星数请求不携带 Canvas 信息。离线 HTML 是导出时快照，不会自动更新；ICS 导入也不会自动同步。不同设备、浏览器、网址的历史不会自动同步。备份排除配置凭证，**不表示课程内容匿名化**；不要公开备份、看板或课件。完整边界见 [系统概述](系统概述.md)。
