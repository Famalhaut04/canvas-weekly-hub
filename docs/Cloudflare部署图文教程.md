# 零基础部署教程 · v2.2

部署一次，之后打开自己的网址，只填 Canvas 令牌。**不需要 agent、Python、KV 或微信 SendKey。**

## 选择创建方式

| 方式 | 条件 |
|---|---|
| 一键部署 | 已有或愿意注册 Cloudflare + GitHub 账号 |
| 复制代码 | 只用邮箱注册 Cloudflare，不需要 GitHub 账号 |

[项目入口](https://famalhaut04.github.io/canvas-weekly-hub/web/) 的设置窗口提供两种方式。Cloudflare 界面名称可能变化，以官方页面为准。

## 方式一：一键部署

1. 点击 [一键创建](https://deploy.workers.cloudflare.com/?url=https://github.com/Famalhaut04/canvas-weekly-hub)。
2. 登录自己的 Cloudflare 与 GitHub，按页面要求授权、创建自己的仓库并部署。
3. 部署成功后，打开自己的 `https://….workers.dev` 网址。

**完成标志：**页面显示“连接你的 Canvas”，版本为 v2.2。不是作者公共引导页，也不是 Hello World。部署按钮会在你的账号创建资源，详情见 [Cloudflare 官方说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

## 方式二：仅邮箱，复制代码

1. 在 [Cloudflare](https://dash.cloudflare.com/sign-up) 注册账号并验证邮箱。普通看板无需购买域名。
2. 在控制台找到 Workers / Workers & Pages，创建 Worker，可先部署默认 Hello World。
3. 回 [项目入口](https://famalhaut04.github.io/canvas-weekly-hub/web/)，展开“只有邮箱？按这 3 步创建”，点击“复制部署代码”。
4. 回自己的 Worker，打开 **Edit code**，在代码区全选，替换为复制的内容，再点 **Deploy**。
5. 打开 Worker 概览里自己的网址，收藏下来。

**完成标志：**打开自己的网址，看到“连接你的 Canvas · v2.2”。只看到 Hello World，说明代码尚未替换成功。不要只复制 `worker/runtime.js`，部署需要完整 `worker.js`。

复制被浏览器拒绝时会下载代码文件；也可点“下载部署代码”，用文本编辑器打开后全选复制。代码首行是“自动生成”，后面包含网页与运行逻辑，不需要自己编辑配置。

## 连接 Canvas

1. 打开自己的助手网址。
2. 点击令牌帮助链接，登录 Canvas，在“账户 → 设置 → 新访问令牌”生成并立即复制。
3. 粘贴到自己的助手，点击“连接并生成看板”。

默认城大。其他学校先展开高级设置、填写 HTTPS 学校域名，并在该学校 Canvas 获取令牌。到期日选填。

**完成标志：**看到自己的课程看板；部分内容不可读取时会显示警告。首次生成与刷新耗时取决于课程数量及网络。以后用顶栏刷新，设置里可下载离线看板、历史备份；日历按钮下载 ICS。

## 旧版升级

- 手动部署：复制最新完整代码，全选替换自己的 Worker，再 Deploy。
- GitHub 部署：同步更新自己的仓库，确认 Cloudflare 成功部署新版本；单纯本项目发布不会更新你的实例。
- 新旧网址数据隔离：在旧页面备份，在新页面导入，再输入令牌。

**如果以前启用过订阅：**

1. 先升级原 Worker。新版 `scheduled()` 不再查询或推送，`/setup` 和 `/ics` 返回暂停提示。
2. 原浏览器保留密钥时，在设置点“停用旧版云端订阅”，移除对应旧 KV 配置与快照。若密钥丢失，在自己的 Cloudflare KV 清理旧 `cfg:` / `snap:` 项。
3. 在自己的 Worker 设置移除旧 Cron；不用的 KV 可以解绑。旧错误记录也由你自行清理。
4. 在学校 Canvas 撤销不再使用的令牌；旧日历 App 可能仍显示缓存事件，需要移除旧订阅。

v2.2 不创建 KV 或 Cron，不提供云端订阅 / 微信启用入口。清除浏览器数据不能撤销云端凭证。

## 常见问题

| 情况 | 处理 |
|---|---|
| 自己的网址打不开 | 检查网络可达性、Cloudflare 部署状态，或自己的绑定域名 |
| 打开后是 Hello World / JSON | 确认替换为 v2.2 完整 worker.js 并 Deploy，直接在浏览器打开根网址 |
| 401 | 到学校 Canvas 重新生成令牌 |
| 403 | 检查学校权限 / 云端访问限制；持续失败可用本地 Python 路线 |
| 请求超时 | 稍后重试，保留原历史，不要反复并行点击 |
| 找不到课程历史 | 换网址或浏览器后需手动导入备份 |

## 隐私

只在自己部署的网址输入令牌。数据经自己的 Worker 查询学校，不经过作者服务器；Cloudflare 会处理转发请求。当前版不持久保存云端凭证，普通配置与历史在浏览器。星数请求不含 Canvas 信息，导出文件含课程信息，请保管好。详见 [系统概述](系统概述.md)。
