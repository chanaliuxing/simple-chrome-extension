# Simple Chrome Extension & Receiver Service

> 一套基于 Manifest V3 的 Chrome 扩展套件（包含本地只读版与云端增强版）与轻量级 Python/SQLite 本地接收器服务。
> 支持一键抓取已渲染页面文本与结构化元数据，静默只读、零依赖、本地去重落盘。

---

## 🌟 核心特性

- **两个 Chrome 扩展（Manifest V3）**：
  - **`extensions/browser-readonly` (纯本地版)**：点一下图标即保存，无弹窗、无配对、无外部网络请求。数据直接 POST 到本机 `127.0.0.1:18765` 接收器。
  - **`extensions/browser-cloud` (云端/双模版)**：支持个人 Token 认证、本地队列重试（断网缓冲与指数退避）、额度管理与选项设置页面，可同时推送云端 API 并备份到本机接收器。
- **超轻量本地服务（`server/collector.py`）**：
  - **仅依赖 Python 3.10+ 标准库**，无需 `pip install` 任何第三方包。
  - 仅监听 `127.0.0.1:18765` 回环地址，安全可靠。
  - SQLite 本地存储：基于 SHA-256 内容寻址、幂等保存、增量更新与自动去重。
- **静默只读安全边界**：
  - 仅在用户主动点击或触发快捷键时，才将解析脚本注入到活动标签页的 **ISOLATED world**。
  - 不篡改网页 DOM、不注入可见元素、不读取 Cookie、不触碰密码表单、不进行后台轮询。
- **丰富工具与全套测试**：
  - 提供后台守护进程管理（macOS LaunchAgent 一键安装/卸载）、终端实时监视器（`show.py`）。
  - 内置完整的单元测试套件（Python `pytest` + Node.js 测试引擎）。

---

## 📁 目录结构

```text
simple-chrome-extension/
├── extensions/
│   ├── browser-readonly/          # 扩展 1：纯本地只读采集扩展（点一下即存本地）
│   │   ├── manifest.json
│   │   ├── background.js
│   │   ├── extractor.js
│   │   ├── common.js
│   │   └── icons...
│   └── browser-cloud/             # 扩展 2：云端与本地双模扩展（带选项页与离线重试队列）
│       ├── manifest.json
│       ├── background.js
│       ├── options.html / options.js
│       ├── projection.js
│       ├── extractor.js
│       └── common.js
├── server/
│   ├── collector.py               # 本地 HTTP 接收器服务（监听 18765，SQLite 存储）
│   └── __init__.py
├── bridge/
│   └── collector.py               # 兼容性导入垫片（指向 server/collector.py）
├── scripts/
│   ├── start-server.sh            # 前台一键启动本地接收器
│   ├── install-service.sh         # macOS LaunchAgent 守护进程安装/卸载
│   └── show.py                    # 终端查看/实时监视捕获的内容
├── tests/
│   ├── test_bridge.py             # 接收服务与存储单元测试（30 项全部通过）
│   ├── test_browser.py            # Playwright 浏览器自动化集成测试
│   ├── background.test.mjs        # 扩展后台生命周期与队列测试（29 项全部通过）
│   ├── e2e_chromium.mjs           # Chromium 端到端沙箱测试
│   └── project-cli.cjs
├── docs/                          # 技术架构与安全协议规范文档
│   ├── SECURITY_AND_PROTOCOL.md
│   ├── TEST_RESULTS.md
│   ├── CODEX_HANDOFF.md
│   └── CLOUD_EXTENSION.md
└── README.md
```

---

## 🚀 快速上手

### 1. 启动本地接收器服务

```bash
# 方式 A：前台运行（推荐首次测试使用）
bash scripts/start-server.sh

# 方式 B：作为 macOS 后台守护进程运行（开机自启）
bash scripts/install-service.sh
```

接收器将监听 `http://127.0.0.1:18765`，数据默认保存在 `~/.gradevidence-browser-capture/captures.sqlite3`。

### 2. 在 Chrome 中加载扩展

1. 打开 Chrome，访问 `chrome://extensions`。
2. 在右上角开启 **“开发者模式” (Developer mode)**。
3. 点击 **“加载已解压的扩展程序” (Load unpacked)**。
4. 选择本仓库中的扩展目录：
   - 纯本地版：选择 `extensions/browser-readonly`
   - 云端/双模版：选择 `extensions/browser-cloud`
5. 建议在工具栏将该扩展图标“固定 (Pin)”，方便查看状态徽标（✓ 成功 / ! 提示）。

### 3. 开始采集

1. 在 Chrome 中打开目标页面（如面经帖子、面试题页）。
2. 等待页面内容渲染完全后，**点击扩展图标** 或使用快捷键：
   - `Ctrl+Shift+S`（Mac 上为 `⌘⇧S`）
3. 扩展图标将短时间变为绿色对勾 **✓** 并提示已保存。

### 4. 查看捕获的数据

打开另一个终端窗口，运行内置的监视工具：

```bash
# 查看最近 5 条捕获记录
python3 scripts/show.py

# 实时监视新进来的捕获（随抓随打）
python3 scripts/show.py --watch

# 查看指定 ID 的详细字段与全文
python3 scripts/show.py <tid> --detail

# 导出所有去重记录为 JSONL 文件
python3 server/collector.py export --out "$HOME/Desktop/captures.jsonl"
```

---

## 🛠️ 服务与脚本说明

| 脚本 / 命令 | 说明 |
|---|---|
| `bash scripts/start-server.sh` | 前台启动本地接收服务，按 `Ctrl+C` 退出 |
| `bash scripts/install-service.sh` | 安装并启动 macOS LaunchAgent 服务 |
| `bash scripts/install-service.sh --status` | 检查后台服务运行状态 |
| `bash scripts/install-service.sh --stop` | 停止并卸载后台服务 |
| `python3 scripts/show.py` | 终端展示捕获记录与正文 |
| `python3 server/collector.py status` | 输出当前 SQLite 数据库中的采集统计指标 |

---

## 🧪 运行测试套件

本项目自带完备的自动化测试：

```bash
# 1. 运行 Python 接收器与存储测试（30 项测试）
pytest tests/test_bridge.py

# 2. 运行 Node.js 扩展后台沙箱与队列测试（29 项测试）
node tests/background.test.mjs
```

---

## 🔒 安全与隐私原则

1. **最小权限**：仅声明 `activeTab`、`notifications` 与 `scripting`，无浏览历史权限、无全量存储权限。
2. **纯回环接口**：服务端仅绑定 `127.0.0.1`，拒绝任何外网和非本机的跨域请求。
3. **内容寻址**：采集数据使用 SHA-256 计算指纹，重复采集不产生垃圾数据，天然幂等。
4. **离线优先**：服务断开时扩展自动排队缓冲，服务恢复后自动补发。

---

## 📄 开源许可

[MIT License](LICENSE)
