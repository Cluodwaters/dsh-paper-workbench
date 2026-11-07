# 文献工作台市场收录材料

目标目录：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。按其 [投稿规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 准备，规则核对日期为 2026-11-07。此目录是待提交材料，不代表已经上架。

## 提交内容

将本目录的 `Cluodwaters__dsh-paper-workbench--plugins-dsh-paper-workbench.yml` 放到目标仓库的 `data/plugins/` 下，一个 PR 只添加这一条。PR 说明见 `PR-BODY.md`，不要手工修改目标仓库自动生成的 README。

- 条目指向插件子目录；该目录的 `package.json` 已声明 `dsh.bundle.patch`。
- 分类为 `docs`，提供准确的中英文功能说明。
- `tarball` 固定指向已验证的 v0.2.4 `.tgz`；后续升级需修改这一地址，不使用带版本文件名的 `latest/download`。
- 市场图标由项目原有 SVG 渲染为 PNG，截图由独立演示资料库的实际界面生成。
- `screenshots.json` 位于插件 `package.json` 旁，所有图片路径留在插件目录内。
- 当前发行包仅支持 Windows x64；已验证 DSH 0.2.2-rc.1，其他版本及系统不作已验证声明。
- 新导入论文默认触发 AI 初读，使用用户自己的 DSH 模型；`autoRead: false` 可关闭。示例截图关闭初读，未提交模型请求。

## 提交前状态核对

仓库已公开。收录要求仓库创建满一天：本仓库创建于 2026-11-06 13:15:17 UTC，在 **2026-11-07 21:15:17（北京时间）** 达标。提交前重新确认 `dsh-plugin` topic 存在、图片链接可访问、安装包可下载且 SHA-256 与 Release 清单一致。

准备验收已完成：`dsh-plugin` / `deepseek-harness` topic 已设置；全新桌面配置成功注册 `dsh-paper-workbench@0.2.4`，源码目录外副本的 11 项浏览器集成检查通过。

收录由目录维护者审核；CI 通过后仍需人工审核及市场同步。准备材料本身不创建 PR，也不安排自动提交。

## 安装问题与验证范围

收到的失败截图选择了 `dsh-paper-workbench-0.2.4-sources.tar.gz`。源码根工程没有插件组合包声明；正确 `.tgz` 的包根目录包含 `dsh.bundle`、patch、独立运行时及后台依赖。已修正直接下载链接、文件用途说明及 Release 资产标签。后续字体、导入按钮与保存位置设置修订仍保持 v0.2.4，并重新打包和更新校验清单；旧包用户需重新下载安装。

独立验收使用源码目录外的打包副本及隔离 DSH 配置，最终包通过 11 项浏览器集成检查；字体专项 6 项检查覆盖宿主字体实时同步、明暗主题、窄屏与阅读缩放。本机通过官方 CLI 重装后核对实际文件及随包运行时。发布时将本地 SHA-256 与 GitHub Release 资产 digest 核对；完整远程文件重新下载未在本次重复执行。

DSH 原生设置现可自定义资料保存位置，保存时继续使用原目录，完整重启后复制校验并启用新位置。存储与迁移相关 88 项单元测试通过；另在隔离 DSH 配置中实测保存、取消、迁移、目标占用后的恢复及原会话继续打开。完整聊天记录仍由 DSH 保存。

演示文献、元数据均为合成数据，截图已更新为本次字号与导入按钮；不包含个人论文、密钥或聊天，不将本机日志和测试数据库提交到仓库。
