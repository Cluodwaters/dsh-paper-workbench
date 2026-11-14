import { api, PersistenceClient } from "./persistence-client.js";
import { appUrl } from "./url.js";

/** All upstream private API access is contained here and pinned to 293d7e1.
 * It must be revalidated when upgrading Zotero Reader. */
export class ZoteroReaderAdapter {
  constructor(frame, onStatus, onNotice) {
    this.frame = frame;
    this.onStatus = onStatus;
    this.onNotice = onNotice;
    this.reader = null;
    this.stateWrites = new Set();
    this.stateError = null;
  }
  async open(document) {
    this.document = document;
    this.persistence = new PersistenceClient(document.snapshot, this.onStatus);
    const embedded = document.embeddedAnnotations || [];
    const externalIds = new Set(embedded.map((annotation) => annotation.id));
    const annotations = [
      ...embedded,
      ...this.persistence.overlay(document.snapshot.annotations),
    ];
    const bytes = await fetch(
      appUrl(`/api/pdf/${document.attachment.id}`),
    ).then((response) => {
      if (!response.ok) throw new Error("无法读取测试副本");
      return response.arrayBuffer();
    });
    await new Promise((resolve, reject) => {
      this.frame.onload = resolve;
      this.frame.onerror = () => reject(new Error("阅读组件加载失败"));
      this.frame.src = appUrl("/vendor/reader.html");
    });
    const host = this.frame.contentWindow;
    if (typeof host.createReader !== "function")
      throw new Error("阅读器构建不完整，请检查构建产物。");
    let deletions = [];
    this.reader = host.createReader({
      type: "pdf",
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
        this.onNotice("本阶段验证阅读与持久化；标签编辑在文献库阶段接入。"),
      onAddToNote: () =>
        this.onNotice("可先导出标注 JSON；笔记编辑器在后续阶段接入。"),
      onRotatePages: () =>
        this.onNotice(
          "本阶段不修改 PDF 页结构；旋转兼容性使用专门的测试副本验证。",
        ),
      onDeletePages: () => this.onNotice("本阶段不删除 PDF 页面。"),
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
    this.timer = setInterval(() => {
      if (this.persistence.error || this.stateError) return;
      if (this.dirty()) this.onStatus("saving", "正在保存标注或阅读位置…");
      else this.onStatus("saved", `已落盘 · 修订 ${this.persistence.revision}`);
    }, 150);
    this.onStatus("saved", `已落盘 · 修订 ${this.persistence.revision}`);
    return this;
  }
  saveViewState(state, primary) {
    if (this.closing) return Promise.resolve();
    const view = primary ? "primary" : "secondary";
    this.lastViewState ??= {};
    this.lastViewState[view] = state;
    const task = (this.stateWriteTail || Promise.resolve())
      .then(() =>
        this.closing
          ? undefined
          : api(
              `/api/state/${this.document.attachment.id}`,
              { view, state },
              { timeoutMs: 5000 },
            ),
      )
      .catch((error) => {
        this.stateError = error;
        this.onStatus("failed", "阅读位置未保存：" + error.message);
      })
      .finally(() => this.stateWrites.delete(task));
    this.stateWrites.add(task);
    this.stateWriteTail = task;
    return task;
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
    this.frame.src = "about:blank";
    this.reader = null;
    this.pdfApplication = null;
  }
  discardAndClose() {
    this.persistence.discard();
    this.closing = true;
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
    const pdfWindow = this.reader?._primaryView?._iframeWindow;
    const selection = pdfWindow?.getSelection();
    const anchor = selection?.anchorNode?.parentElement;
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
          : this.currentPage(),
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
