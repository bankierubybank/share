// Applies the saved theme ("light" | "dark"; absent = follow system) before first paint.
try {
  var t = localStorage.getItem("share.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
