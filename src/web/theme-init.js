// Runs before stylesheets so an embedded dark workspace never paints a light frame.
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("embed") !== "harness") return;
  const requested = params.get("theme");
  document.documentElement.dataset.theme = ["light", "dark"].includes(requested)
    ? requested
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  document.documentElement.dataset.harness = "true";
  // Embedded documents have their own font cascade. Read only the Host's
  // published/computed typography so custom DSH fonts also reach this iframe.
  try {
    if (window.parent === window) return;
    const host = window.parent.document;
    const syncTypography = () => {
      const style = window.parent.getComputedStyle(host.body);
      const family = style.getPropertyValue("--dsh-font-family-text").trim() || style.fontFamily;
      const size = parseFloat(style.getPropertyValue("--dsh-content-font-size"));
      document.documentElement.style.setProperty("--h-font-family", family);
      document.documentElement.style.setProperty("--h-font-size", `${Math.max(15, Number.isFinite(size) ? size : 15)}px`);
    };
    syncTypography();
    const observer = new MutationObserver(syncTypography);
    for (const element of [host.documentElement, host.body])
      observer.observe(element, { attributes: true, attributeFilter: ["style", "class"] });
    window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  } catch {
    // Standalone/cross-origin previews keep the local system-font fallback.
  }
})();
