// Left-panel tab switching (媒体 / 字幕) for the v1.18 docked layout.
// Pure UI chrome — all editor logic lives in renderer.js; this file must
// not touch editor state.
(() => {
  const tabs = document.querySelectorAll(".side-tab");
  const bodies = document.querySelectorAll(".tab-body");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      bodies.forEach((b) => b.classList.toggle("hidden", b.dataset.tabBody !== tab.dataset.tab));
    });
  });
})();
