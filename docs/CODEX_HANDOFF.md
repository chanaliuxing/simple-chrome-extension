# FAST_LOCAL_FIRST handoff — browser-readonly v0.1.0

## Deliverable

本包已经包含扩展、接收器、单项测试、后台模拟测试和可选完整安装测试；不是伪代码。
不需要 npm build。运行接收器只需要 Python 3.10+ 标准库。
先落在稳定目录，再让用户加载 extension/ 并按 README 配对。

本轮仅只读查看 GitHub `chanaliuxing/hr-platform`，参考版本：
`63e401d6e1c90b45190c3b39abf7b584529d9707`。
读取了 `AGENTS.md`、`services/collector/adapters/opencli_patch.py`、`capture_batch.py`。
没有本地仓库工作区，没有 push、commit、PR、merge、CI 或 AWS 操作。

## 接手后第一件事

在用户的 Mac 上安装本扩展并打开一条用户能正常阅读的真实目标帖。
检查是否得到当前 thread ID、可信 forum ID、正确主楼 text。
观察 SQLite 真正落盘，不以“扩展加载成功”代替链路成功。
然后测试重复帖、其他版块、主楼折叠、停止/重新启动、本地 receiver 断线重试。

不要先改全量 schema、不要跑全项目 CI、不要进入部署流程。
不要把未知 DOM 结构改成抓 document.body.innerText 的全文兜底。
不要为取得内容而读取 message_bbcode/message_html、Cookie 或隐藏正文。
不要将 forum 缺失时的白名单检查改为放行。

## 与现有管线接线

包内 `ge.browser_capture.v1` 是隔离本地协议，不能原样 POST 到现有 ingest。
现有 capture_batch.py 的 v1.1 校验要求若干 source_operations/browser_navigations 等字段；
本扩展没有发起网页请求或浏览器导航，不能把这些字段伪造成 1 来通过校验。
先检查当前已合并的 EdgeSpool/observation 接口，再加一个窄 adapter 显式转换。
保留 source identity、visible-only capture_scope、partial 标记、method/version 和原始快照。
现有管线使用的 source_direct 与“浏览器扩展采集方法”不是同一个字段维度。
没有 source_post_id、没有可信 forum、身份冲突时应停在待校准，不能猜字段填充。
接线之前只本地落盘与导出，不开启云端 worker、正式分类评测或生产上传。

## 后续 PyAutoGUI

本版不输出鼠标控制指令、不注入页面标记、不提供任意脚本执行端点。
下一模块才增加列表候选的纯读取坐标接口；CSS viewport 坐标需要本机桌面校准，
必须有窗口焦点、目标身份、位置有效期、点击后实际 thread ID 校验。
不要把这次的“只读扩展”交付误报为“300 条夜间无人值守已跑通”。
