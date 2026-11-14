import { appUrl } from "./url.js";

export const embedded =
  new URLSearchParams(location.search).get("embed") === "harness" &&
  window.parent !== window;
const origin = location.origin;
let handlers = {};
function send(message) {
  if (embedded) window.parent.postMessage({ version: 1, ...message }, origin);
}
export function openWorkbench(value) {
  const url = new URL(appUrl(value), location.href);
  if (embedded && url.origin === origin) {
    if (url.pathname.endsWith("/reader.html")) {
      const page = url.searchParams.get("page");
      send({
        type: "paper-workbench:open",
        view: "reader",
        attachmentId: url.searchParams.get("id"),
        ...(page !== null ? { pageIndex: Number(page) } : {}),
      });
      return;
    }
    if (url.pathname.endsWith("/tools.html")) {
      send({
        type: "paper-workbench:open",
        view: "tools",
        tab: url.hash === "#citations" ? "citations" : "index",
        itemIds: (url.searchParams.get("items") || "")
          .split(",")
          .filter(Boolean),
      });
      return;
    }
    send({ type: "paper-workbench:open", view: "library" });
    return;
  }
  window.open(url.href, "_blank", "noopener,noreferrer");
}
export function requestAi(action, context) {
  if (!embedded || !["translate", "explain", "ask"].includes(action)) return;
  send({ type: "paper-workbench:ai", action, context });
}
export function connectHarness(view, callbacks = {}) {
  if (!embedded) return;
  handlers = callbacks;
  document.documentElement.dataset.harness = "true";
  document.body.classList.add("harness-embedded");
  document.querySelectorAll("[data-harness-only]").forEach((element) => {
    element.hidden = false;
  });
  send({ type: "paper-workbench:ready", view });
}
if (embedded) {
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link || link.download || event.defaultPrevented) return;
    if (link.getAttribute("href").startsWith("#")) return;
    const url = new URL(link.href, location.href);
    if (
      url.origin !== origin ||
      !/(?:\/reader\.html|\/tools\.html|\/)$/u.test(url.pathname)
    )
      return;
    if (url.pathname === location.pathname && url.hash && !url.search) return;
    event.preventDefault();
    openWorkbench(url.pathname + url.search + url.hash);
  });
  window.addEventListener("message", async (event) => {
    if (event.source !== window.parent || event.origin !== origin) return;
    const message = event.data;
    if (
      !message ||
      message.type !== "paper-workbench:command" ||
      message.version !== 1 ||
      typeof message.requestId !== "string" ||
      message.requestId.length > 128
    )
      return;
    try {
      let value;
      if (message.command === "theme") {
        const theme = message.payload?.theme;
        if (!["light", "dark"].includes(theme))
          throw new Error("Unknown theme");
        document.documentElement.dataset.theme = theme;
        await handlers.theme?.(theme);
        value = { theme };
      } else if (message.command === "flush") {
        if (document.querySelector("dialog[open]"))
          throw new Error("请先保存或关闭当前对话框，再切换页面。");
        await handlers.flush?.();
        value = { saved: true };
      } else if (message.command === "context") {
        value = (await handlers.context?.()) ?? null;
      } else if (message.command === "refresh") {
        value = (await handlers.refresh?.()) ?? null;
      } else if (message.command === "navigate") {
        if (!handlers.navigate) throw new Error("请先打开论文。");
        value = await handlers.navigate(message.payload);
      } else throw new Error("Unknown command");
      send({
        type: "paper-workbench:result",
        requestId: message.requestId,
        ok: true,
        value,
      });
    } catch (error) {
      send({
        type: "paper-workbench:result",
        requestId: message.requestId,
        ok: false,
        error: { code: error.code || "BRIDGE_FAILED", message: error.message },
      });
    }
  });
}
