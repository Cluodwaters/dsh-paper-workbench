# 本地文献工作台 · v0.3.2

> 原独立应用的历史使用说明。DSH 插件安装请看 [README](README.md)，源码构建请看 [BUILD](BUILD.md)。下文提到的本机样本和交付报告不随仓库提供。

第三阶段已接入 Windows 桌面安装包、整库正文索引、离线中英文 OCR 和可更新的 Word 引用，继续使用已验证的 Zotero 阅读与标注组件。Microsoft Word 已完成实机回归；WPS 提供兼容连接器，本机尚未实测。

## 安装与第一次打开

1. 运行 `PaperWorkbench-0.3.2-win-x64-Setup.exe`，可保留默认应用安装目录或选择自定义目录。从开发工作区运行安装器若出现写入被拒绝，请先将安装包复制到普通下载目录后运行。
2. 首次打开选择“打开已有资料库”，选择本工程的 `data/workspace` 文件夹，里面包含 `library.sqlite`；也可建立新库。
3. 以后从桌面或开始菜单的“文献工作台”进入。菜单支持打开资料库目录和切换资料库，切换后重新启动生效。

安装包包含 Node 运行时、阅读器、OCR 模型和引用样式，日常使用无需另装 Node 或 Python。程序与资料分开存放，卸载保留独立资料库。安装包是未签名的个人构建，Windows 可能显示未知发布者。

v0.3.1 修复了安装文件复制失败时误报“文献工作台无法关闭”的问题。安装前会检查目标目录的实际写入能力，拒绝直接覆盖包含 `library.sqlite` 的资料库；安装后检查关键运行文件。安装器改用直接解压，内部可执行文件使用 `PaperWorkbench.exe`，界面与快捷方式仍显示“文献工作台”。本机已在 `D:\Tools\文献工作台` 完成安装，1,612 个分发文件逐一核对通过，并通过 11 项实际桌面回归。此处路径只是本机安装结果，不是程序固定要求。

## 开发模式（浏览器）

双击 **启动文献工作台.cmd**，会启动隐藏的本地服务并打开浏览器。使用完毕可双击 **停止文献工作台.cmd**。原来的“启动验证台 / 停止验证台”入口仍可使用。

默认地址：http://127.0.0.1:4178 。当前机器已有运行依赖，现成构建无需重新安装。

## 日常使用

v0.3.2 修复手绘工具单击产生的点标注被错误拒绝的问题；点和连续笔迹都可以保存、恢复及导出。保存失败时，关闭窗口会提供“返回阅读器”“重试保存并关闭”“放弃未保存修改并关闭”三个选项。放弃仅清除本窗口未保存的修改，已经自动保存的内容不会撤销。标注 JSON 也可在保存失败时导出当前内容作为备份，文件中的 `saveState` 会标明未保存状态。

1. **导入论文**：点击“导入 PDF”、选择多个文件、拖放文件，或从下拉菜单导入文件夹。文件会复制到管理目录，原件保留；相同内容只导入一次。
2. **校正文献信息**：选择条目后点击右侧“编辑”。按署名顺序添加作者，填写年份、期刊、DOI、卷期页码、摘要等。信息缺失会显示“待补全”，不会用下载时间猜发表年份。
3. **使用 DOI 候选**：填入 DOI 后点击“联网补全”，查看当前值与 Crossref 候选值，勾选要采用的字段，再保存。只查询 DOI，不上传 PDF；离线时仍可手动编辑。
4. **组合检索**：作者、年份、期刊、标签和状态可同时筛选。不同维度取交集，同一维度内默认任一匹配；作者与标签也可选择全部匹配。搜索框支持中文短词和多个关键词。
5. **保存智能集合**：把常用条件保存到左侧。新导入或修改后符合条件的文献会自动出现在集合中。
6. **阅读与标注**：点击 PDF 链接在独立阅读页面打开。高亮、下划线、批注和导出继续使用原有模块。
7. **批量整理**：勾选本页条目后，可统一设置状态、期刊、年份、增删标签，或导出 CSL-JSON 数据。
8. **回收站**：移入回收站不会删除附件或标注，可以恢复。当前不提供永久删除原文件。
9. **期刊别名**：左下角可把缩写或不同拼写归入一个标准名称。原始期刊字段保留，归一规则影响显示和检索。

元数据以“保存信息”成功为完成依据。未保存草稿按页签保留，重新打开时可恢复本机草稿；其他窗口已经更新的条目会触发版本冲突，避免静默覆盖。

## 全文索引与 OCR

导入后自动提取 PDF 原生文字。搜索框可选“文献信息”“PDF 正文”或“全部内容”，与作者、年份、期刊等筛选组合使用。多个关键词同时满足，英文引号短语按连续词检索，中文支持短词。命中摘要可以直接打开对应页。

左下角“全文索引与 OCR”显示进度，支持暂停、继续、取消和重试。扫描页可本地识别；文字层乱码时可选择重新识别所有页面。阅读器的“正文 / OCR”查看逐页文本并导出 TXT。

OCR 结果单独存储，参与检索，不改变 PDF 内容哈希和标注坐标。复杂标题、作者、公式、图表和低清扫描可能识别有误，需对照原页核对。当前没有生成带新 OCR 文字层的 PDF。任务逐页保存检查点，失败或取消保留旧索引，重启后可继续。

## 在 Microsoft Word 中插入引用

1. 在 Word 打开 `.docx`，将光标放在正文引用位置。选中文字时，引用插在选择范围末尾。
2. 在工作台勾选文献并点击“插入写作引用”，或在“Word / WPS 引用”页面搜索加入多篇文献。可设置引用页码和前后缀。
3. 默认沿用文档已有样式；新文档使用 GB/T 7714—2015，也可明确选择国标 2025、APA 第七版或 IEEE。
4. 预览目标文档、引用和文献表，确认后写入；在 Word 正常保存文档。
5. 在文献表位置点击“插入 / 更新文献表”。增删或重排正文引用后点击“刷新全文引用”，同步更新编号和文献表。

引用使用独立的 `PW_CITE_V1` / `PW_BIB_V1` 域标记，保存稳定文献 ID、页码和必要书目信息。重复引用共用编号，参考文献表去重；保存重开后仍可更新。预览后文档或光标变化会拒绝写入，重新预览即可。一次更新支持 Word 的一次撤销，程序只更新自己的域。

当前是工作台连接 Word 的流程，尚未添加 Word 功能区按钮。适用 `.docx` 正文；只读、受保护或开启修订记录的文档会提示后停止写入。脚注、页眉和多人协作未验证。WPS 需提供 COM 和撤销事务接口，本机没有 WPS，不能视作已实测支持。

## 数据位置与备份

- 当前主库：data/workspace/library.sqlite。
- 管理的 PDF 副本：data/workspace/files。
- 标注 PDF 导出：data/workspace/exports。
- 升级前自动备份：data/workspace/backups。
- 第二阶段隔离测试库：data/stage2-qa；测试条目不会写入主库。
- 第三阶段隔离测试库：data/stage3-qa；新增测试条目不写入主库。
- 完整备份请先停止程序，再复制整个资料库目录，不能只复制 PDF。

数据库升级使用有版本的迁移脚本。第二阶段升级没有改变既有文献、附件、标注、阅读位置和历史导出，逐表及文件校验见 output/stage2-primary-upgrade.json。

第三阶段原数据和文件校验见 `output/stage3-primary-upgrade.json`。完整备份应包含整个资料库，并先关闭程序。

## 配置

- PAPER_WORKBENCH_DATA：资料库目录。
- PAPER_WORKBENCH_PORT：本机端口，默认 4178。
- PAPER_WORKBENCH_LABEL：界面显示的资料库名称。
- PAPER_WORKBENCH_MAX_PDF_MB：单个 PDF 导入上限，默认 200 MiB。
- PAPER_WORKBENCH_PDFTOPPM：独立 PDF 验证工具的路径；不影响日常运行。
- PAPER_WORKBENCH_AUTO_INDEX=0：开发时关闭自动全文入队。
- PAPER_WORKBENCH_OFFICE_BRIDGE：开发时指定原生连接器路径。

运行环境目前验证过 Node 25.8.1，使用内置 node:sqlite。服务仅监听 127.0.0.1。核心整理与阅读功能不需要公网，DOI 候选查询需要连接 Crossref。

## 当前边界

- 现有样本书目信息仍保持待核对，需要手动校正或通过 DOI 取得候选；没有把未知作者、年份、期刊自动填成猜测。
- 密码 PDF 单独报告失败，不阻塞其他文件。已有内嵌标注保持只读；部分高级标注工具的限制沿用第一阶段说明。
- 当前导入采用托管副本；尚未提供直接引用外部原文件的存储模式。
- 草稿属于当前浏览器的本机数据，不跨设备同步。未确认保存时，强制终止、断电或清除浏览器数据不承诺零丢失。
- Word 连接器使用 Windows 的 .NET Framework，当前已验证 Word 16.0；其他系统需新增写作连接器。

## 架构和报告

- [第二阶段功能与边界](PHASE2.md)
- [第三阶段功能、验证与边界](PHASE3.md)
- [架构与后续参考文献插入](ARCHITECTURE.md)
- [第一阶段实测报告](output/report/第一阶段技术验证结果.html)
- [第二阶段交付报告](output/report/第二阶段文献库交付报告.html)
- [第三阶段交付报告](output/report/第三阶段桌面与写作功能交付报告.html)

元数据模型、查询条件和候选字段选择位于 src/domain；数据库与索引位于 src/storage；导入和 PDF 用例位于 src/application；外部元数据来源和 PDF 处理封装在适配器中；界面位于 src/web/library。个人论文、数据库、输出和缓存均已排除出版本控制。

## 重复验证

执行 npm test 可运行存储、源文件、迁移、规范化、组合检索、候选信息和导入测试。

第三阶段还包括全文检索与 CSL 单元测试，`scripts/validate-ocr-recovery.mjs` 的真实 OCR 重启测试，`scripts/validate-office.mjs` 的真实 Word 回归，以及 `scripts/validate-desktop.mjs` 的真实打包桌面回归。这些脚本只用于隔离测试库和专用 Word 文档。

构建桌面包：`npm ci` → `node scripts/fetch-phase3-assets.mjs` → `npm run build:bridge` → `npm test` → `npm run build:desktop`。固定资源摘要在 `phase3-assets.lock.json`，npm 版本在 `package-lock.json`。

本机开发目录存在额外继承权限：实测相同原生可执行文件在该目录可能启动失败，复制到普通权限目录后正常。开发者应使用干净的原生测试目录；发布采用正常应用安装目录，不修改系统权限。Word 测试用 `PAPER_WORKBENCH_QA_BIN` 指定干净二进制目录；桌面测试用 `PAPER_WORKBENCH_DESKTOP_EXE` 和 `PAPER_WORKBENCH_PLAYWRIGHT` 指定应用及开发用 Playwright。

浏览器回归通过 Playwright CLI 的 run-code --filename 使用 scripts/validate-library-ui.js、validate-library-safety.js、validate-draft-isolation.js 和 validate-stage2-reader.js。它们会修改隔离测试库，不应对主库直接运行。旧阅读器验证脚本仍可在 reader.html 中使用。

PDF 写入流程变更时，运行 scripts/verify-exports.py 做独立结构与渲染检查。它依赖 pypdf、pypdfium2、Pillow 和 Poppler。当前依赖版本及源提交见 sources.lock.json。

## 上游构建

当前目录已有可运行构建。重新构建时，在固定源码目录按相应 package-lock.json 安装依赖，然后：

1. 在 third_party/zotero-reader/pdfjs/pdf.js 执行 node node_modules/gulp-cli/bin/gulp.js generic。
2. 在工程根目录执行 node scripts/stage-reader-assets.mjs。
3. 在 Reader 目录执行 node node_modules/webpack-cli/bin/cli.js --config-name web --no-optimization-minimize。固定语言资源已预取。
4. Document Worker 的 PDF 写入模块使用生产依赖；本阶段没有启用 ML/EPUB 处理链。

不要在未做保存、重启和外部导出回归的情况下升级上游组件。许可证采用 AGPL-3.0-only 路线，完整文本见 LICENSE，上游归属见 THIRD_PARTY_NOTICES.md。本项目尚未公开发布。

