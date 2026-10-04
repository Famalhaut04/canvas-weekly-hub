# 本地 HTTPS 证书兼容修复 · v1

日期：2026-10-04。用户在首次抓取时收到 `FETCH_FAILED: 请求失败，请检查网络与学校接口；未判定为令牌过期`。本轮只修改项目代码与验证；个人 Token 和课程未读取、未验证。

| 修改 / 新增文件 | 用途 |
|---|---|
| `canvas_weekly_report.py` | Windows 批量 DER 证书加载失败时用同一组可信系统证书的 PEM 编码重建验证上下文；课程 API 与下载复用；细分证书加载 / 验证 / 握手失败 |
| `site-template/index.html` | 识别三种 TLS 错误类别，提供针对性说明 |
| `web/index.html`、`worker.js` | 根据现有构建流程重新生成，版本仍 v2.2 |
| `tests/1004_HTTPS证书回归_v1.py` | 10 项标准库模拟验证，确保可信用途筛选、错误脱敏、失败关闭、重定向保护与下载无 Canvas 认证头 |
| `tests/1004_匿名HTTPS诊断_v1.py` | 不读取配置 / Token，只探测学校匿名认证边界并输出 HTTP 状态，不输出正文或响应头 |
| `tests/artifacts/1004_*` | 实际匿名诊断和回归输出 |
| `docs/1004_从零部署与个人令牌测试指南_v1.md`、本报告、`memory/2026-10-04.md` | 更新排错说明与工作记录 |

## 已复现的原因

- 现有 Python 为 3.8.20，链接的 OpenSSL 显示 `OpenSSL 3.5.7 9 Jun 2026`。
- 不读取配置，仅执行 `ssl.create_default_context()` 就出现 `[ASN1: NOT_ENOUGH_DATA] not enough data`。堆栈发生在加载 Windows 证书库的批量 DER 阶段，早于发送学校请求。
- 学校域名的 DNS / TCP 443 检查通过；系统 curl 的匿名 HTTPS HEAD 收到学校 302 登录跳转。这只证明该次网络与系统 HTTPS 可用，不验证个人 Token。
- OpenSSL 默认 CA 文件与目录返回 None；未安装额外 CA 包。
- 系统中允许服务器认证的同一组证书改用 PEM 加载后，SSL 上下文创建成功。一次独立探测加载 41 项、解析失败 0 项；因此不能把它写成“确认某张系统证书损坏”。已有证据支持批量 DER 加载兼容问题。
- 项目修复后匿名调用 `/api/v1/users/self` 收到预期 HTTP 401；证书验证与主机名校验均开启。请求没有 Token，不读取用户身份、课程内容或错误正文。

Python 3.8 默认 Windows 加载行为与用途筛选依据 [CPython 3.8 的 ssl 源码](https://raw.githubusercontent.com/python/cpython/3.8/Lib/ssl.py)。`create_default_context` 的验证设置与 cadata 参数机制可参考 [Python 官方 ssl 说明](https://docs.python.org/3/library/ssl.html#ssl.create_default_context)；当前官方通用页为新版本文档，3.8 行为以对应源码与本机实测为准。

## 修复边界

正常环境仍先调用原默认上下文。只有本机初始化失败且运行于 Windows 时，枚举 CA / ROOT 中与 Python 默认筛选相同、允许 SERVER_AUTH 的 X.509 证书，转为 PEM 后交给默认验证上下文。保留 OpenSSL 默认验证路径；不新增可信根，不忽略解析失败的证书，不关闭证书校验或主机名检查。

如果枚举、解析或 PEM 加载失败，明确返回 `tls_setup_failed` 并停止；学校握手时证书验证失败是 `tls_verify_failed`，其他 SSL 连接异常是 `tls_handshake_failed`。错误提示不展示上游正文、原异常敏感字符串或凭证，也不把它们写成令牌过期。

API 仍保留 NoApiRedirect，不向重定向地址发送 Bearer。课件下载只复用 HTTPS 上下文，保持原有不附带 Canvas 认证头的下载请求。没有修改个人配置、系统证书、持久环境变量或依赖。

## 实际验证

| 验证 | 结果 | 证据 |
|---|---|---|
| 当前项目匿名 HTTPS 诊断 | 默认上下文复现 ASN1；修复上下文 OK；Hostname=True；CERT_REQUIRED=True；匿名 HTTP=401 | [诊断日志](../tests/artifacts/1004_匿名HTTPS诊断_v1.txt) |
| 新 TLS 模拟回归 | 10 tests，OK | [TLS 日志](../tests/artifacts/1004_HTTPS证书回归_v1.txt) |
| 原本地配置回归 | 11 tests，OK | [配置日志](../tests/artifacts/1004_本地配置回归_v1.txt) |
| 原课程读取回归 | 19 tests，OK | [课程日志](../tests/artifacts/1004_课程读取回归_v1.txt) |
| 网页 / 生成包回归 | 59 tests，59 pass，0 fail | [网页日志](../tests/artifacts/1004_网页回归_v1.txt) |
| 构建、Python 3.8 编译与 diff check | 已重建网页 / Worker；3 个 Python 文件编译通过；diff check 通过，暂存区为空，HEAD 未变 | [交付核查日志](../tests/artifacts/1004_证书修复交付核查_v1.txt)，未请求个人课程 |

匿名 401 表示到达认证边界，不代表个人 Token 已通过，也不证明有课程列表权限。本轮未实际抓取课程、未部署 Cloudflare、未提交、push、发布或回复 Issue。此前 Issue #5 修复与用户配置保留。

## 用户继续测试

在 PowerShell 项目目录执行：

```powershell
Set-Location -LiteralPath 'D:\GitHub\Projects\canvas-weekly-hub'
& 'D:\DevTools\anaconda3\envs_dirs\agent-sec38\python.exe' -B '.\canvas_weekly_report.py'
```

配置文件无需因本次证书修复重新填写。首次建议保持 `download_files=false`；运行结束后根据 OK / PARTIAL_OK / FETCH_FAILED 判断，再重载本地网页。仍报错时反馈脱敏提示即可，不发送 Token。

## 另发现的已有下载保留风险

`canvas_weekly_report.py` 的 `download_new_file` 异常分支会清理目标文件：已有同名文件大小不同、且新下载在写入之前失败时，也可能删除原文件。此清理行为不属于本次证书兼容修复，本轮未执行它、未删除用户文件。建议后续改为临时文件写入、成功后安全替换，失败产物隔离并保留原有文件。首次验证先关闭下载，可避免该分支影响课程读取测试。已用本机解释器确认 `Path.unlink(missing_ok=True)` 本身支持 Python 3.8，不能把该风险误判为参数兼容问题。
