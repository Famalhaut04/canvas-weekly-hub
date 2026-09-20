# Cloudflare 转发代理 · 手把手图文教程

> 全程只需要：一个能收邮件的邮箱、约 5 分钟。
> 你要做的只是：注册一个免费账号 → 点几下按钮 → 复制一个网址。
> 不需要写代码、不需要信用卡、不需要安装任何软件。

---

## 开始前：30 秒了解你在做什么

你的浏览器被学校禁止直接访问 Canvas 接口（这是学校的安全设置，不是 bug），
所以需要一个**只属于你自己的"传话助手"**——它部署在国际大厂 Cloudflare 的免费服务上：

```
你的浏览器 ──①──▶ 你的传话助手（Cloudflare，免费） ──②──▶ 城大 Canvas
    ▲                      │
    └──── ③ 看板数据原路返回 ─┘
```

- 你的令牌只经过**你自己的**助手，Cloudflare 官方、本项目的作者都看不到
- 代码 100% 开源：https://github.com/Famalhaut04/canvas-weekly-hub/blob/main/worker.js
- 不想要了？删除只需 10 秒（见文末）

---

## 第 1 步：注册 Cloudflare 账号（免费，约 1 分钟）

1. 打开网址：**https://dash.cloudflare.com/sign-up**
2. **Email**：填你的邮箱（QQ 邮箱、163、Gmail 都可以）
3. **Password**：设置一个密码
4. 点 **Create Account**（创建账户）
5. 如果 Cloudflare 发来验证邮件，去邮箱点 **Verify**（验证）链接

> 📩 收不到验证邮件？先看垃圾邮箱；还不行就换一个邮箱重新注册。

---

## 第 2 步：一键部署你的"传话助手"（约 1 分钟）

1. 回到课程助手网页（设置窗口里），点 **「一键部署（免费，约2分钟）↗」** 链接
   （或者直接打开：https://deploy.workers.cloudflare.com/?url=https://github.com/Famalhaut04/canvas-weekly-hub ）
2. 如果页面要求登录 GitHub：点 **Continue to GitHub**（继续到 GitHub）→ 登录你的 GitHub 账号
   → 点 **Install**（安装）授权
3. 页面会显示将要创建的内容（一个 Worker + 一个 KV 存储），滚动到页面底部
4. 点 **Create and Deploy**（创建并部署）
5. 等待约 30 秒，看到 **成功页面**，上面有一个网址，形如：

   ```
   https://canvas-weekly-hub.你的子域.workers.dev
   ```

6. **复制这个网址**——这就是你的「转发代理地址」！

> 🈶 英文按钮对照表（部署页面出现的词）：
>
> | 页面上的英文 | 意思 | 你要做什么 |
> |---|---|---|
> | Continue to GitHub | 继续到 GitHub | 点它 |
> | Install / Authorize | 安装 / 授权 | 点它，选默认即可 |
> | Create and Deploy | 创建并部署 | 点它（关键的按钮） |
> | Deployment successful | 部署成功 | 说明完成了 |
> | Visit / View | 访问 / 查看 | 点开能看到一段 JSON 文字就对了 |
>
> 第一次部署时 Cloudflare 可能会让你设置一个 workers.dev 子域名：
> 填一串**英文+数字**（例如 `xiaoming2026`），这是你专属的网址前缀。

---

## 第 3 步：回到课程助手，粘贴网址

1. 打开课程助手网页：https://famalhaut04.github.io/canvas-weekly-hub/web/
2. 点右上角 **⚙️ 设置**
3. 「① 转发代理」里粘贴刚才复制的 `.workers.dev` 网址
4. 「③ 访问令牌」里粘贴你的 Canvas 令牌（获取方法见弹窗里的说明）
5. 点 **「🔌 测试连接」** → 看到 ✅ 就大功告成
6. 点 **「🚀 抓取并生成看板」** → 你的专属看板出现了！

---

## 备用方案：一键部署打不开？（手动粘贴，约 3 分钟）

个别网络环境可能打不开部署页面，用这个备用方法：

1. 打开 https://dash.cloudflare.com 并登录
2. 左侧菜单点 **Workers & Pages** → 点 **Create application**（创建应用）
3. 选 **Create Worker**（创建 Worker）→ 名字随便填（如 `canvas`）→ 点 **Deploy**
4. 部署完成后点 **Edit code**（编辑代码）
5. 删光左侧默认代码，打开这个网址，**全选复制**里面的全部代码：
   https://raw.githubusercontent.com/Famalhaut04/canvas-weekly-hub/main/worker.js
6. 粘贴进编辑框 → 点右上角 **Deploy** → 完成
7. 你的代理地址：`https://你取的名字.你的子域.workers.dev`

> ⚠️ 此备用方式默认不包含 KV 存储，**看板功能完整**，但「日历订阅」和「微信每日提醒」
> 两个附加功能需要用第 2 步的一键部署（会自动创建 KV）才能开启。

---

## 常见问题

| 问题 | 解决 |
|---|---|
| 部署页面全是英文看不懂 | 只需认得 3 个按钮：Continue to GitHub → Install → Create and Deploy，见上方对照表 |
| 一键部署页面报错 / 打不开 | 改用上方"备用方案"手动粘贴；或过一会儿再试 |
| 测试连接提示 Failed to fetch | Worker 地址没填对（应以 `https://` 开头、以 `.workers.dev` 结尾），或部署还没完成 |
| 测试连接提示 HTTP 401 | 是 Canvas 令牌的问题：重新生成令牌并粘贴（与 Cloudflare 无关） |
| workers.dev 网址在手机流量下打不开 | 部分运营商干扰该域名；手机连家里 WiFi 即可正常，电脑上不受影响 |
| 想删除助手 | 打开 https://dash.cloudflare.com → Workers & Pages → 选中 → Settings → Delete；再删除 KV（Storage & Databases → KV）即可，令牌随之消失 |

---

## 安全说明

- 助手代码完全开源，共约 230 行，任何人可审查：它只做"转发请求"这一件事
- **不存储**：你的令牌与课程数据不会被写入 Cloudflare（代理模式是"过手即忘"）
- 一键部署创建的 KV 存储**位于你自己的 Cloudflare 账号**，仅用于日历订阅与微信提醒
- 随时可以删除：删掉 Worker 与 KV 后，你在这个项目里的所有痕迹即告消失

---

*本教程对应 worker.js 于 2026-09-20 的版本 · 有卡住的地方欢迎在仓库提 Issue*
