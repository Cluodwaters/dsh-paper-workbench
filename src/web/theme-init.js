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
})();
