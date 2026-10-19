// Copy of Maui's themeFoucScript: set theme and scale before first paint.
// A same-origin file because the production CSP (script-src 'self') blocks inline scripts.
(function () {
  var preference = "system";
  try {
    var storedPreference = window.localStorage.getItem("maui-theme");
    if (
      storedPreference === "system" ||
      storedPreference === "light" ||
      storedPreference === "dark"
    ) {
      preference = storedPreference;
    }
  } catch {}
  var theme =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;

  var scale = "system";
  try {
    var storedScale = window.localStorage.getItem("maui-scale");
    if (
      storedScale === "system" ||
      storedScale === "medium" ||
      storedScale === "large"
    ) {
      scale = storedScale;
    }
  } catch {}
  document.documentElement.dataset.scale =
    scale === "system"
      ? window.matchMedia("(pointer: coarse)").matches
        ? "large"
        : "medium"
      : scale;
})();
