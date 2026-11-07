# 构建、测试与发布

直接使用插件请下载 GitHub Release 中的 `.tgz`。下面面向继续开发源码的使用者。

## 环境

- Windows x64，Node **25.8.1** 的完整发行版（包含 npm）。桌面打包脚本检查此固定版本，并从该 Node 安装目录查找 npm。
- Git、可用的 .NET Framework C# 编译器；用于构建 Word 连接器。
- 生成合成单元测试样本需要 Python 和 `pypdf`：`python -m pip install pypdf`。
- 源码和依赖恢复需要访问 GitHub、npm 及固定资源下载地址。

原始论文、数据库、会话和浏览器资料不进入 Git。不要复制原机器的 `data/` 或 `output/` 到仓库里提交。

## 恢复固定依赖与阅读器

在仓库根目录运行下面的 PowerShell 命令。`third_party/` 是按锁文件恢复的本地目录，未作为另一份源码副本提交。

```powershell
npm ci
New-Item -ItemType Directory -Force output | Out-Null
node scripts/fetch-source-tree.mjs
node scripts/fetch-phase3-assets.mjs

Push-Location third_party/zotero-reader/pdfjs/pdf.js
npm ci
node node_modules/gulp-cli/bin/gulp.js generic
Pop-Location

node scripts/stage-reader-assets.mjs

Push-Location third_party/zotero-reader
npm ci
node node_modules/webpack-cli/bin/cli.js --config-name web --no-optimization-minimize
Pop-Location

Push-Location third_party/zotero-document-worker
npm ci --omit=dev --omit=optional --workspaces=false
Pop-Location
```

下载脚本核对固定提交下的 Git blob；资源脚本检查 SHA-256。Reader 的语言插件按固定提交恢复语言资源。本插件只使用 Document Worker 的 PDF 路径，不需要构建它的预览应用、ML 模型或完整 EPUB 处理链。

上述步骤整理自项目现有构建脚本；本次托管没有在一台全新机器上重做全部联网构建。若遇到下载或构建失败，保留错误输出，先核对固定依赖，不要随意升级 vendor 或跳过校验。

## 单元测试

干净克隆不带个人论文测试样本。先生成完全合成的测试 PDF：

```powershell
python scripts/prepare-public-fixtures.py
npm test
```

生成器提供导入、只读内嵌标注、密码保护和损坏输入测试所需的四个 PDF；若目标文件已存在，会在写入前退出，保护本机原有样本。它不会生成真实论文样本清单，也不代替完整的阅读器、OCR 和导出回归。

原来的 `prepare-samples.py`、`prepare-fixtures.py` 用于自备样本的扩展验收。其输出可能包含本机路径，始终保留在被忽略的 `data/validation/`。

## 构建 DSH 插件包

完成依赖恢复及 Reader 构建后，在根目录运行：

```powershell
node scripts/stage-desktop.mjs
node plugins/dsh-paper-workbench/tools/package.mjs
Push-Location plugins/dsh-paper-workbench/dist
npm pack --pack-destination .. --ignore-scripts
Pop-Location
```

`stage-desktop.mjs` 编译 Word 连接器并按 npm 的生产依赖图收集外部依赖。插件打包脚本组合最新 `src/`、固定 Reader/OCR 资源、运行时和许可证，并生成文件哈希记录。必须在 `dist` 目录里运行 `npm pack`，避免误打包根工程。

插件 Host 的原生设置使用固定版本 `@deepseek-ai/schemastery`，由根项目 `npm ci` 安装，打包时连同 `@deepseek-ai/cosmokit`、`@standard-schema/spec` 及许可证显式复制并捆绑。独立验收同时检查这些 Host 依赖和后台生产依赖，避免安装后依赖源码目录。

生成的 `plugins/dsh-paper-workbench/dsh-paper-workbench-<版本>.tgz` 不进入 Git 历史，作为 Release 附件发布。

Release 另附 `dsh-paper-workbench-<版本>-sources.tar.gz`：包含对应运行代码的仓库文件，以及按 `sources.download.json` 校验过的固定上游源码。它是开发材料，不是可安装插件：根 `package.json` 没有 `dsh.bundle`，直接交给 DSH 会提示「这个包没有声明组合包」。npm 依赖仍按锁文件安装；无需把 `node_modules/` 提交到源码仓库。

## 独立安装验收

设置 `DSH_PAPER_WORKBENCH_HARNESS` 为包含 `DeepSeek Harness.exe` 的安装目录，再运行：

```powershell
$env:DSH_PAPER_WORKBENCH_HARNESS = "<DSH安装目录>"
node plugins/dsh-paper-workbench/tools/verify-package.mjs --fixture "<合成测试PDF的绝对路径>"
```

验收还需可用的 Chromium 与 Playwright；具体路径参数见验证脚本。它将包复制到源码之外，检查独立 Node、依赖、Host、阅读器和桥接。普通阅读回归关闭自动初读；模型行为应另用合成论文在隔离 DSH 会话中验收。

不要对日常资料库运行 QA 脚本。`qa/` 和 `output/` 中的日志、登录 URL、截图和报告均不发布。有关验证记录的历史文档引用的是本机交付证据，不是仓库必带文件。

## 发布规则

1. 功能变化时修改插件版本和版本记录；保留源码与二进制所用上游版本、许可证及构建材料。只纠正下载入口、说明或市场展示时，可保留原版本及已验证的安装包哈希。
2. 运行与变更相关的测试；打包依赖或运行时变化必须重新做源码目录外的验收。
3. 检查 Git 暂存内容，排除个人文件、环境凭据和本机输出。
4. 提交源码后运行 `python plugins/dsh-paper-workbench/tools/prepare-release.py`。工具校对清单、安装包与源码，生成 `output/releases/v<版本>/` 中的带版本安装包、固定名 `dsh-paper-workbench-windows-x64.tgz`、对应源码和 `SHA256SUMS.txt`。发布 `v<版本>` 标签并将这四个文件上传到同一 GitHub Release。发布正文首行直链固定名 `.tgz`；资产标签区分「Windows 插件安装包」和「开发者源码（不能直接安装）」。
5. 从 Release 重新下载，校对哈希，检查安装包根目录的 `package.json` 含 `dsh.bundle.patch` 且对应 patch 文件存在，再用干净配置执行 `dsh plugin add`；安装说明明确支持的平台及宿主版本。

v0.2.4 按用户要求在同一版本修订界面字体、导入按钮和保存位置设置：功能修订需要重新打包 `.tgz`、对应源码并更新 SHA-256，版本标签应对应本次源码提交。已经安装旧包的设备需要重新下载、安装并完整重启 DSH；仅比较版本号不能判断是否包含这次修订。

## 市场更新通道（从 v0.2.5 起）

目录的 `tarball` 使用 `https://github.com/Cluodwaters/dsh-paper-workbench/releases/latest/download/dsh-paper-workbench-windows-x64.tgz`。每次正式发行都必须保留相同的附件文件名，并把 Release 设为最新稳定版。不要把源码包作为此附件，不要改为带版本号文件名的 `latest/download`。

市场原生更新检查从最新 Release 的 `vX.Y.Z` 标签读取该标签下 `plugins/dsh-paper-workbench/package.json`，核对包名和版本，再检测同名安装包是否存在。版本必须递增；不覆盖已发布版本的运行代码或移动旧标签。无需修改目录 YAML 或添加插件内自动更新程序。

首次切换：本地 `file:` 来源与旧的带版本文件名 URL 不能自动匹配此通道，用户应通过上述固定 URL 重新安装一次。后续由已收录该条目的 dshmarket 版本负责检测、下载与安装。资料与 DSH 设置独立于包目录，更新不删除资料；更新后完整重启 DSH。

验收应使用隔离配置：先安装上一版，切换在线来源，确认最新版本检测和更新后不再提示同一更新；校对合成资料的论文 ID、附件哈希、摘要、会话绑定与设置。市场尚未合并时可用拟提交条目调用市场本身的检查函数，但必须把该结果与公开市场已收录区分。
