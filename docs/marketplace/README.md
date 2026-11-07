# 文献工作台市场收录与更新

目标目录：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，展示网站：[dshmarket.com](https://dshmarket.com/)。规则核对日期为 2026-11-07。v0.2.5 使用原生 GitHub Release 更新通道；提交申请与审核收录分别记录，不把准备完成当成已上架。

## 提交内容

将本目录的 `Cluodwaters__dsh-paper-workbench--plugins-dsh-paper-workbench.yml` 放到目标仓库的 `data/plugins/` 下，只添加这一条，正文见 `PR-BODY.md`。不修改其自动生成的 README 或工作流。

- 条目指向插件子目录，清单声明 `dsh.bundle.patch`，仓库已有 `dsh-plugin` topic。
- `docs` 分类，中英文功能说明，PNG 图标及清单旁的 `screenshots.json`；截图仅用合成文献。
- 发行包包含独立 Node 25.8.1、后台生产依赖、Reader、OCR 资源及许可证。仅支持 Windows x64，已验证 DSH 0.2.2-rc.1。
- 新导入论文默认触发 AI 初读，使用用户自己的 DSH 模型；`autoRead: false` 可关闭。普通整理阅读不需要模型。
- 仓库创建于 2026-11-06 13:15:17 UTC，2026-11-07 21:15:17（北京时间）满 24 小时。若提交时尚未达标，明确保留年龄检查；上游 `regate.yml` 会周期复查非草稿 PR，年龄失败存在 24 小时复查冷却，不承诺达标时立即自动通过。

收录须经目录维护者审核、合并及市场同步。提交后的 PR 链接和实际检查结果在本文件继续记录。

## 更新通道

固定在线来源：

```text
https://github.com/Cluodwaters/dsh-paper-workbench/releases/latest/download/dsh-paper-workbench-windows-x64.tgz
```

每次稳定 Release 提供同名附件；`vX.Y.Z` 标签下插件子目录的 `package.json` 包名和版本与附件一致。商店将当前安装版本与最新版本比较，并下载对应标签下的附件，不从源码根目录安装。带版本文件名副本和 `sources.tar.gz` 继续供手动安装与开发归档。

本地 `.tgz` 或旧的带版本文件名来源需通过固定 URL 重新安装一次；不会仅因为上传新 Release 就自动变成在线来源。资料库、设置与会话绑定保留。目录收录并同步后，在支持 GitHub Release 更新的 dshmarket 中刷新并检查更新，安装完成后完整重启 DSH。核对的市场实现版本为 1.73.14。

## 验证范围

发布前检查版本、组合包声明、独立运行时、外部生产依赖、Release 哈希与完整远程下载；使用源码目录外的打包副本执行浏览器检查。更新测试使用隔离配置与合成资料，并用市场自身的发布源识别及版本检查逻辑验证通道。拟提交目录用于测试，不代表公开目录已同步。

v0.2.4 已完成字体、导入按钮、原生保存位置设置与目录选择器修订；v0.2.5 汇总这些修订并提供递增版本号。数据格式不变，完整对话仍由 DSH 管理。个人论文、数据库、模型凭据、聊天与本机测试日志不发布。
