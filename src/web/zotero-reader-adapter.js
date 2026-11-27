import { api, PersistenceClient } from "./persistence-client.js";
import { appUrl } from "./url.js";

const readerLocaleFiles = [
  "brand.ftl",
  "en-US/reader.ftl",
  "zh-CN/zotero.ftl",
  "zh-CN/reader.ftl",
  "zh-CN/workbench.ftl",
];

async function loadReaderLocale() {
  try {
    return await Promise.all(
      readerLocaleFiles.map(async (file) => {
        const response = await fetch(appUrl(`/reader-locales/${file}`), {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`无法加载阅读器词条 ${file}`);
        return response.text();
      }),
    );
  } catch {
    // createReader supplies its built-in locale when no resources are passed.
    return undefined;
  }
}

/** All upstream private API access is contained here and pinned to 293d7e1.
 * It must be revalidated when upgrading Zotero Reader. */
export class ZoteroReaderAdapter {
  constructor(frame, onStatus, onNotice) {
    this.frame = frame;
    this.onStatus = onStatus;
    this.onNotice = onNotice;
    this.reader = null;
    this.stateWrites = new Set();
    this.pendingViewStates = new Map();
    this.viewStateDrain = null;
    this.stateError = null;
  }
  async open(document) {
    this.document = document;
    this.persistence = new PersistenceClient(document.snapshot, () => this.reportSaveState());
    await this.persistence.recover();
    const embedded = document.embeddedAnnotations || [];
    const externalIds = new Set(embedded.map((annotation) => annotation.id));
    const annotations = [
      ...embedded,
      ...this.persistence.overlay(document.snapshot.annotations),
    ];
    const [bytes, ftl] = await Promise.all([
      fetch(appUrl(`/api/pdf/${document.attachment.id}`)).then((response) => {
        if (!response.ok) throw new Error("无法读取 PDF 文件");
        return response.arrayBuffer();
      }),
      loadReaderLocale(),
    ]);
    await new Promise((resolve, reject) => {
      this.frame.onload = resolve;
      this.frame.onerror = () => reject(new Error("阅读组件加载失败"));
      this.frame.src = appUrl("/vendor/reader.html");
    });
    const host = this.frame.contentWindow;
    if (typeof host.createReader !== "function")
      throw new Error("阅读器构建不完整，请检查构建产物。");
    if (ftl) host.document.documentElement.lang = "zh-CN";
    let deletions = [];
    this.reader = host.createReader({
      type: "pdf",
      ftl,
      data: { buf: new host.Uint8Array(bytes) },
      title: document.attachment.originalName,
      readOnly: false,
      authorName: "个人标注",
      loggedIn: true,
      showAnnotations: true,
      annotations,
      primaryViewState: document.readingState.primary || {
        pageIndex: 0,
        scale: "page-width",
        scrollMode: 0,
        spreadMode: 0,
      },
      secondaryViewState: document.readingState.secondary || undefined,
      sidebarWidth: 235,
      sidebarOpen: true,
      sidebarView: "annotations",
      bottomPlaceholderHeight: 0,
      toolbarPlaceholderWidth: 0,
      enableReadAloud: false,
      onDeleteAnnotations: (ids) => {
        if (this.closing) return;
        deletions.push(...ids);
      },
      onSaveAnnotations: (upserts) => {
        if (this.closing) return Promise.resolve();
        const removed = deletions.filter((id) => !externalIds.has(id));
        deletions = [];
        return this.persistence.enqueue(
          upserts.filter((item) => !externalIds.has(item.id)),
          removed,
        );
      },
      // Primary location is captured directly from PDF.js view events below;
      // upstream's delayed callback can be lost when switching documents quickly.
      onChangeViewState: (state, primary) => {
        if (!primary) this.saveViewState(state, false);
      },
      onOpenLink: (url) => {
        if (/^https?:\/\//i.test(url))
          window.open(url, "_blank", "noopener,noreferrer");
      },
      onConfirm: (_title, text) => window.confirm(text),
      onOpenTagsPopup: () =>
        this.onNotice("阅读器内暂不支持编辑批注标签，请在文献库中管理文献标签。"),
      onAddToNote: () =>
        this.onNotice("暂不支持添加到独立笔记，可在阅读工具中导出标注 JSON。"),
      onRotatePages: () =>
        this.onNotice("为保护原始 PDF 与批注坐标，暂不支持直接旋转页面。"),
      onDeletePages: () =>
        this.onNotice("为保护原始 PDF 与批注坐标，暂不支持删除页面。"),
      onToggleSidebar: () => {},
      onChangeSidebarWidth: () => {},
      onChangeSidebarView: () => {},
      onToggleContextPane: () => {},
      onTextSelectionAnnotationModeChange: () => {},
      onSetDataTransferAnnotations: () => {},
      onSaveCustomThemes: () => {},
      onClosePopup: () => {},
      onBringReaderToFront: () => {},
    });
    const manager = this.reader._annotationManager;
    if (
      !manager?._unsavedAnnotations ||
      typeof manager._triggerSaving !== "function"
    )
      throw new Error("阅读器内部保存接口已变化，需重新验证适配器。");
    // Avoid the upstream 1s / 10s delayed-save window. The client journals before each HTTP write.
    manager._skipAnnotationSavingDebounce = true;
    const initialTheme = globalThis.document?.documentElement?.dataset?.theme;
    if (initialTheme === "dark") this.reader.setColorScheme("dark");
    // This pinned upstream revision does not resolve Reader.initializedPromise.
    // Its primary PDF view provides the actual readiness contract.
    let timeout;
    try {
      const ready = await Promise.race([
        this.reader._primaryView.initializedPromise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("PDF 阅读初始化超时")),
            45000,
          );
        }),
      ]);
      if (ready === false) throw new Error("PDF 阅读初始化未完成");
    } finally {
      clearTimeout(timeout);
    }
    this.pdfApplication =
      this.reader._primaryView._iframeWindow.PDFViewerApplication;
    this.viewAreaListener = (event) =>
      this.saveViewState(this.locationState(event.location), true);
    this.pdfApplication.eventBus.on("updateviewarea", this.viewAreaListener);
    this.pdfApplication.pdfViewer.update();
    await this.captureViewState();
    await this.persistence.pump();
    const updateStatus = () => this.reportSaveState();
    updateStatus();
    this.timer = setInterval(updateStatus, 150);
    return this;
  }
  reportSaveState() {
    const state = this.getSaveState();
    const error = this.persistence.error || this.stateError;
    const message = state === "conflict" ? "保存冲突 · 本地草稿已保留"
      : error ? "未保存：" + error.message
      : state === "saving" ? "正在保存标注或阅读位置…"
      : `已落盘 · 修订 ${this.persistence.revision}`;
    this.onStatus(state, message);
  }
  saveViewState(state, primary) {
    if (this.closing) return Promise.resolve();
    const view = primary ? "primary" : "secondary";
    this.lastViewState ??= {};
    this.lastViewState[view] = state;
    this.pendingViewStates.set(view, state);
    if (!this.viewStateDrain) {
      const drain = (async () => {
        while (!this.closing && this.pendingViewStates.size) {
          const [nextView, nextState] = this.pendingViewStates.entries().next().value;
          this.pendingViewStates.delete(nextView);
          try {
            await api(
              `/api/state/${this.document.attachment.id}`,
              { view: nextView, state: nextState },
              { timeoutMs: 5000 },
            );
            this.stateError = null;
          } catch (error) {
            if (!this.closing) {
              this.stateError = error;
              this.onStatus("failed", "阅读位置未保存：" + error.message);
            }
          }
        }
      })().finally(() => {
        this.stateWrites.delete(drain);
        if (this.viewStateDrain === drain) this.viewStateDrain = null;
        if (!this.closing && this.pendingViewStates.size) {
          const [viewKey, latest] = this.pendingViewStates.entries().next().value;
          this.saveViewState(latest, viewKey === "primary");
        }
      });
      this.stateWrites.add(drain);
      this.viewStateDrain = drain;
    }
    return this.viewStateDrain;
  }
  locationState(location) {
    const viewer = this.pdfApplication.pdfViewer;
    return {
      pageIndex: (location?.pageNumber || viewer.currentPageNumber) - 1,
      scale: location?.scale || viewer.currentScaleValue,
      top: location?.top,
      left: location?.left,
      scrollMode: viewer.scrollMode,
      spreadMode: viewer.spreadMode,
    };
  }
  captureViewState() {
    if (!this.pdfApplication) return Promise.resolve();
    this.pdfApplication.pdfViewer.update();
    return this.saveViewState(
      this.locationState(this.pdfApplication.pdfViewer._location),
      true,
    );
  }
  dirty() {
    if (this.closing) return false;
    const manager = this.reader?._annotationManager;
    return Boolean(
      manager?._unsavedAnnotations.size ||
      manager?._savingInProgress ||
      this.persistence?.queue.length ||
      this.pendingViewStates.size ||
      this.stateWrites.size,
    );
  }
  getSaveState() {
    if (this.persistence?.error?.code === "REVISION_CONFLICT")
      return "conflict";
    if (this.persistence?.error || this.stateError) return "failed";
    return this.dirty() ? "saving" : "saved";
  }
  async flush() {
    await this.captureViewState();
    const manager = this.reader?._annotationManager;
    // Upstream waits for our acknowledgement. A failed HTTP write intentionally
    // keeps that promise pending, so awaiting it here would hide the error forever.
    if (manager)
      Promise.resolve(manager._triggerSaving()).catch((error) => {
        this.persistence.error = error;
        this.onStatus("failed", error.message);
      });
    await this.persistence.flush();
    const deadline = Date.now() + 15000;
    while (this.dirty()) {
      if (this.persistence.error) throw this.persistence.error;
      if (this.stateError) throw this.stateError;
      if (Date.now() > deadline) throw new Error("保存尚未完成");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    if (this.stateError) throw this.stateError;
  }
  async retry() {
    this.stateError = null;
    for (const [view, state] of Object.entries(this.lastViewState || {}))
      this.saveViewState(state, view === "primary");
    await this.persistence.retry();
  }
  async close() {
    await this.flush();
    this.pdfApplication?.eventBus.off("updateviewarea", this.viewAreaListener);
    clearInterval(this.timer);
    this.persistence.release();
    this.frame.src = "about:blank";
    this.reader = null;
    this.pdfApplication = null;
  }
  discardAndClose() {
    this.persistence.discard();
    this.closing = true;
    this.pendingViewStates.clear();
    this.stateError = null;
    this.pdfApplication?.eventBus.off("updateviewarea", this.viewAreaListener);
    clearInterval(this.timer);
    const manager = this.reader?._annotationManager;
    if (manager) {
      clearTimeout(manager._saveTimeout);
      manager._unsavedAnnotations.clear();
    }
  }
  annotations() {
    return structuredClone(this.reader._annotationManager._annotations);
  }
  currentPage() {
    return this.pdfApplication.pdfViewer.currentPageNumber - 1;
  }
  context() {
    const attachment = this.document.attachment;
    const view = this.reader?._lastViewPrimary === false && this.reader._secondaryView
      ? this.reader._secondaryView : this.reader?._primaryView;
    const pdfWindow = view?._iframeWindow;
    const activePage = (pdfWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber ?? (this.currentPage() + 1)) - 1;
    const selection = pdfWindow?.getSelection();
    const node = selection?.anchorNode;
    const anchor = node?.nodeType === 1 ? node : node?.parentElement;
    const text = anchor?.closest(".textLayer")
      ? selection.toString().trim().slice(0, 12000)
      : "";
    const selectedPage =
      Number(anchor?.closest(".page")?.dataset.pageNumber) - 1;
    return {
      attachmentId: attachment.id,
      itemId: attachment.itemId,
      sourceHash: attachment.sourceHash,
      readingPageIndex: this.currentPage(),
      pageIndex:
        text && Number.isInteger(selectedPage) && selectedPage >= 0
          ? selectedPage
          : activePage,
      ...(text ? { selection: { text } } : {}),
    };
  }
  setTheme(theme) {
    if (!["light", "dark"].includes(theme))
      throw new Error("Unknown reader theme");
    this.reader?.setColorScheme(theme);
  }
  async goToPage(pageIndex) {
    if (
      Number.isInteger(pageIndex) &&
      pageIndex >= 0 &&
      pageIndex < this.document.attachment.pages
    ) {
      this.pdfApplication.pdfViewer.currentPageNumber = pageIndex + 1;
      await this.captureViewState();
    }
  }
  snapshot() {
    return {
      attachmentId: this.document.attachment.id,
      sourceHash: this.document.attachment.sourceHash,
      revision: this.persistence.revision,
      format: "zotero-pdf-v1",
      annotations: this.annotations(),
    };
  }
}
