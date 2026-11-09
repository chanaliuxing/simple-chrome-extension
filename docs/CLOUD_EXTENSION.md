# GradEvidence 云端采集扩展（v1.2.1）

> 原来的纯本地版本保留在 [`tools/browser-readonly/`](../browser-readonly/)（点一下 → 存到本机接收器 → 再用 `scripts/upload-captures` 上传）。
> 这个是新版：**点一下 → 存到浏览器本地 → 直接推送到 GradEvidence 云端**，不需要启动任何本地服务。给愿意贡献面经的用户用，每人一个 token。

## 和原版的关系

| | 原版 `browser-readonly` | 新版 `browser-cloud` |
|---|---|---|
| 读页面 | `extractor.js` | **同一个文件，逐字节相同**（测试会检查） |
| 保存到哪 | 本机接收器 `127.0.0.1:18765`（要先启动） | 浏览器本地（`chrome.storage.local`）+ 云端 API；可选再发一份给本机接收器 |
| 上传云端 | 另跑 `scripts/upload-captures` | 点击时直接推送 `POST /internal/v1/collector/ingest` |
| 凭证 | 运营者自己的 collector token | 每个贡献者一个个人 token（`gec_…`），24 小时内最多 1000 篇 |
| 推送格式 | Python `hr_collector.browser_projection` | `projection.js`，与 Python 版**逐字节一致**（`services/api/tests/test_cloud_extension_contract.py`） |

## 静默只读：网站感觉不到它

- 只有你点图标（或按 Ctrl/⌘+Shift+U）时，才把 `common.js` + `extractor.js` 注入到当前标签页的 **ISOLATED world**；平时不在任何网页上运行（没有 `content_scripts`）。
- 只读已经渲染出来的主楼文字和少量元数据：不点击、不滚动、不翻页、不展开、不读 Cookie、不读表单，不往网页里写任何东西（DOM、样式、属性、全局变量都不碰）。
- 推送请求由扩展后台（service worker）直接发往 `api.gradevidence.click`，网页看不到；**不向一亩三分地发任何请求**。
- 没有 `web_accessible_resources` / `externally_connectable`，网页无法探测到扩展。
- 真实 Chromium 验证（`tests/e2e_chromium.mjs`）：采集期间网页 DOM 变动 0 次、页面看不到任何扩展全局变量、页面没有发出任何请求。

这些是对扩展自身行为的保证，不等于保证任何网站在任何情况下都无法察觉（比如账号的浏览频率本身）。请按正常阅读速度使用。

## 安装（贡献者）

1. 拿到扩展文件夹（我们发的 zip 解压后，或仓库里的 `tools/browser-cloud/extension`），放在一个不会移动的位置。
2. Chrome 打开 `chrome://extensions` → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选择 **`extension`** 文件夹。
3. 安装后会自动打开设置页：粘贴我们发给你的 token（`gec_` 开头）→「保存并测试连接」。显示「连接成功」和剩余额度就好了。只有贡献者 token 能用：填入其他类型的 token（比如我们内部采集器的）会提示「此 token 不是贡献者 token」，不会推送任何内容。
4. 建议把扩展图标钉到工具栏（地址栏右边拼图图标 → 图钉），这样能看到 ✓ / ! 状态。

## 使用

1. 打开一条面经（`/interview/thread/<id>`、`/bbs/thread-<id>-1-1.html`、`/home/thread/<id>`、`/interview/problems/company/<公司>/<题目>`、`/interview/post/<id>`、`/interview/guides/<slug>` 都可以），**等页面完全显示**。
2. 点扩展图标，或按 **Ctrl+Shift+U**（Mac：**⌘⇧U**；可在 `chrome://extensions/shortcuts` 修改）。
3. 图标变绿 ✓ = 已推送（或云端已有，无需重复推送）；变红 ! = 未完成，鼠标悬停看原因。

| 提示 | 意思 |
|---|---|
| 已推送，几分钟内上线并进入人工审核 | 成功；几分钟后在设置页「刷新上线状态」能看到「已上线」和链接；我们的审核会决定是否保留 |
| 已推送…（这页标记为不完整：锁定、含图片或被折叠） | 同上，也会上线；扩展只要看到正文里有图片就会标「不完整」，所以只是提醒 |
| 这条已经推送过，内容没有变化 / 之前推送过更完整的版本 | 不重复推送，不占额度 |
| 今日推送额度已用完 | 24 小时内已推 1000 篇；已存本地并排队，额度恢复后自动推送 |
| 网络错误…已存本地并排队 | 断网或服务器暂时不可用；1/5/15/60 分钟后自动重试 |
| token 无效或已停用 | 检查 token；在设置页重新「保存并测试连接」后会自动补推 |
| 云端拒收（422） | 页面格式不符合要求，这条不会再重试 |
| 未保存：waiting / not_target … | 页面还没显示完，或不是支持的页面；等一下再点 |

「已推送」代表服务器已经收到并写入数据库（写入成功后才回答）；每一次推送都会出现在我们后台的「推送记录」里，不管有没有上线。推送的页面（包括标记为不完整的：锁定题、含图片、正文被折叠）都会在几分钟内自动上线，并进入我们的人工审核；审核不通过的会被隐藏。设置页「最近记录」的「网站」一栏显示每条现在在网站上的状态（已上线 / 等待上线 / 已被隐藏……），已上线的可以直接点开；点「刷新上线状态」更新。

设置页（右键扩展图标 →「选项」）里可以：看待推送队列并「立即重试」、看最近记录、导出本地记录（JSONL，`ge.browser_capture.v2` 格式）、清空本地记录、关闭本地存档或系统通知。

## 你推送的内容

- 每一条都记在你的 token 名下。请只推送你在页面上实际看到的面经。
- 我们可以按 token 查看、批量下架一个 token 推送的全部内容并停用 token。
- token 只在你的浏览器里保存，请不要分享；丢了请联系我们换新 token（历史记录保留在原身份下）。

## 运营者

发 token、查谁推的、批量下架、恢复：见 [`docs/CONTRIBUTOR_TOKENS.md`](../../docs/CONTRIBUTOR_TOKENS.md)。

本机测试：

```bash
node --test tools/browser-cloud/tests/background.test.mjs          # service worker（队列、额度、重试、换 token、manifest 边界）
uv run --project services/api pytest services/api/tests/test_cloud_extension_contract.py   # 与 Python 投影逐字节一致 + 真实 ingest
NODE_PATH=$(npm root -g) node tools/browser-cloud/tests/e2e_chromium.mjs                  # 真 Chromium（需要 Playwright）
```

打包给贡献者：`cd tools/browser-cloud && zip -r gradevidence-cloud-extension-1.0.0.zip extension`（zip 不要提交到 Git）。
