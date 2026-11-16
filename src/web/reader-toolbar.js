// Keep the embedded reader's secondary actions out of the document viewport.
// Move the existing controls so their persistence and reader handlers stay intact.
export function compactReaderToolbar() {
  const toolbar = document.querySelector(".toolbar");
  const title = toolbar.querySelector("#document-title");
  const actions = toolbar.querySelector(".actions");
  const ai = document.querySelector(".harness-ai-tools");
  const status = document.getElementById("save-status");
  const retry = document.getElementById("retry");
  const trigger = document.createElement("button");
  trigger.id = "reader-tools-toggle";
  trigger.type = "button";
  trigger.textContent = "阅读工具";
  trigger.setAttribute("aria-label", "阅读工具");
  trigger.title = "阅读工具";
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "reader-tools");
  trigger.setAttribute("popovertarget", "reader-tools");
  const panel = document.createElement("div");
  panel.id = "reader-tools";
  panel.setAttribute("popover", "auto");
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "阅读工具");
  const label = document.createElement("div");
  label.className = "reader-tools-label";
  label.textContent = "文档与标注";
  actions.prepend(label);
  panel.append(actions, ai);
  // A failed save must remain visible and retryable even when tools are closed.
  toolbar.append(status, retry, trigger);
  document.body.append(panel);
  document.body.classList.add("compact-reader");
  const controls = new Map(
    [title, status, retry, ...actions.querySelectorAll("[id]")].map((element) => [element.id, element]),
  );
  function closePanel() {
    if (panel.matches(":popover-open")) panel.hidePopover();
  }

  const position = () => {
    const rect = trigger.getBoundingClientRect();
    const { innerWidth, innerHeight } = trigger.ownerDocument.defaultView;
    panel.style.top = `${rect.bottom + 6}px`;
    panel.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
    panel.style.maxHeight = `${Math.max(0, innerHeight - rect.bottom - 14)}px`;
  };
  panel.addEventListener("beforetoggle", (event) => {
    if (event.newState === "open") {
      position();
      // Explicit focus preserves the PDF range (unlike default mousedown)
      // and guarantees the next click into its frame emits a blur to dismiss.
      trigger.focus({ preventScroll: true });
    }
    trigger.setAttribute("aria-expanded", String(event.newState === "open"));
  });
  // Keep selected PDF text available when opening tools with the mouse.
  trigger.addEventListener("mousedown", (event) => event.preventDefault());
  panel.addEventListener("click", (event) => {
    // Export can disable its button synchronously before this event bubbles.
    if (event.target.closest("button")) panel.hidePopover();
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      panel.hidePopover();
      trigger.focus({ preventScroll: true });
    }
  });
  const resize = () => {
    if (panel.matches(":popover-open")) position();
  };
  // Pointer events in the PDF's child frame do not bubble to this document.
  const blur = () => {
    if (
      panel.matches(":popover-open") &&
      trigger.ownerDocument.activeElement?.tagName === "IFRAME"
    )
      panel.hidePopover();
  };
  function watchViewport(viewport) {
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("blur", blur);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("blur", blur);
    };
  }
  let unwatch = watchViewport(window);

  return {
    getControl: (id) => controls.get(id),
    mountHeader(titleSlot, actionSlot) {
      // Both slots belong to our same-origin host. Keeping the original nodes
      // also keeps the existing reader, annotation and export handlers.
      const host = titleSlot.ownerDocument;
      if (host !== window.parent.document || actionSlot.ownerDocument !== host)
        throw new Error("阅读器顶栏位置无效。");
      closePanel();
      unwatch();
      titleSlot.append(title);
      actionSlot.append(status, retry, trigger, panel);
      toolbar.hidden = true;
      unwatch = watchViewport(host.defaultView);

      const release = () => {
        window.removeEventListener("pagehide", release);
        if (title.ownerDocument !== host) return;
        closePanel();
        unwatch();
        toolbar.prepend(title);
        toolbar.append(status, retry, trigger);
        document.body.append(panel);
        toolbar.hidden = false;
        unwatch = watchViewport(window);
      };
      window.addEventListener("pagehide", release, { once: true });
      return release;
    },
  };
}
