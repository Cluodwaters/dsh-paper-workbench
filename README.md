# 文献工作台 · DeepSeek Harness 插件

在 DeepSeek Harness（DSH）中整理、阅读和批注文献，按需打开 AI 侧栏。当前插件版本 **0.2.1**，已验证平台为 **Windows x64 + DSH 0.2.2-rc.1**。

- 独立「文献工作台」入口，沿用 DSH 主题，提供文献库、PDF 阅读器和工具页。
- 文献库助手按需检索标题、作者、期刊、年份、标签和已保存摘要；不直接读取论文全文或完整论文对话。
- 每篇论文有独立 DSH 对话。导入后默认自动初读，识别基础信息，保存主题、科学问题、方法、行文逻辑、发现、局限和待核查问题。
- 主助手可以委派单篇论文任务。委派会话与用户阅读会话分开，共享带版本与来源的论文摘要。
- 复用 DSH 原生会话持久化和上下文压缩，使用 SQLite FTS5 按需检索，避免把整个资料库塞入上下文。
- 普通整理、阅读、批注和本地 OCR 不需要模型。自动初读、翻译与问答使用 DSH 当前账号和模型；可设置 `autoRead: false` 关闭后续导入的自动初读。

## 在其他设备安装

1. 在 Windows x64 设备安装兼容的 DSH，并配置好需要使用的模型账号。
2. 登录有权限的 GitHub 账号，进入 [Releases 下载页](https://github.com/Cluodwaters/dsh-paper-workbench/releases)，下载 `dsh-paper-workbench-0.2.1.tgz`。GitHub 自动生成的 Source code 压缩包用于开发，不能直接作为插件安装。
3. 在 PowerShell 中运行，将路径替换为下载文件的绝对路径：

   ```powershell
   dsh plugin --profile desktop add "C:\Downloads\dsh-paper-workbench-0.2.1.tgz"
   ```

   如果 `dsh` 未加入 PATH，使用 DSH 安装目录内的 `resources/runtime/cli/bin/dsh.cmd`：

   ```powershell
   & "<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "<安装包绝对路径>"
   ```

4. 从 DSH「应用 → 退出」完整退出再重新打开，在左侧进入「文献工作台」。仅关闭窗口可能隐藏到托盘，未必重新加载插件。

安装包包含后台 Node 25.8.1、生产依赖、阅读器、OCR 模型和许可证，日常使用无需自行构建。当前安装包不能直接用于 macOS、Linux 或 Windows ARM。

下载页同时提供 `SHA256SUMS.txt`。可运行 `Get-FileHash -Algorithm SHA256 "<安装包绝对路径>"`，与清单中的值比较。

## 数据与会话

默认资料库位于 `%LOCALAPPDATA%\dsh-paper-workbench\data`，与插件安装目录分开。插件保存论文、批注、元数据、摘要、任务和会话绑定；完整对话保存在 DSH 的原生会话存储中。

**安装插件不会迁移或同步原设备的论文和聊天。** 完整迁移需要分别处理插件资料库及其关联的 DSH 会话；仅复制资料库不能恢复完整聊天。备份前应完整退出 DSH，再复制整个资料库目录。卸载插件不删除资料库。

本仓库不包含个人论文、资料库、聊天记录、模型凭据、浏览器资料或本机验收截图。GitHub 的私有访问权限与软件的 AGPL 许可证分别保留。

## 开发与架构

这是包含插件与本地后台的完整源码仓库。源码中的独立应用版本为 0.3.2，DSH 插件版本为 0.2.1，两者版本号分别维护。

| 路径 | 内容 |
|---|---|
| `plugins/dsh-paper-workbench/` | DSH Host、前端入口、Agent 调度、打包和独立运行验证 |
| `src/domain/`、`src/application/`、`src/storage/` | 领域规则、用例与事务存储 |
| `src/web/`、`src/adapters/`、`src/server/` | 阅读界面、外部组件适配与本机传输接口 |
| `desktop/` | 原独立应用入口与 Word 连接器源码 |
| `scripts/`、`tests/` | 固定上游源码恢复、构建和验证 |
| `resources/` | OCR 模型、引用样式、图标和许可证 |

- [插件使用、Agent 关系及上下文限制](plugins/dsh-paper-workbench/README.md)
- [构建、测试与发布说明](BUILD.md)
- [版本记录](CHANGELOG.md)
- [原独立应用说明](STANDALONE.md)
- [架构](ARCHITECTURE.md) · [第三方归属](THIRD_PARTY_NOTICES.md)

正文/OCR 初读不能代替图表与公式的视觉核验，AI 识别和摘要需对照原文。跨设备自动同步、向量检索和图像模型输入尚未实现。

## 许可证

项目及插件使用 [AGPL-3.0-only](LICENSE)。上游提交、资源摘要和依赖版本分别固定在 `sources.lock.json`、`sources.download.json`、`phase3-assets.lock.json` 与各 `package-lock.json` 中。发布包保留上游许可证与归属说明。
