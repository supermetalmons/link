export const observeBottomControlsViewport = (
  container: HTMLElement,
  controls: HTMLElement,
): (() => void) => {
  const viewport = window.visualViewport;
  if (!viewport) {
    return () => {};
  }

  let offset = 0;
  let viewportHeight = 0;
  let frame: number | null = null;

  const update = () => {
    frame = null;
    const originalBottom = controls.getBoundingClientRect().bottom + offset;
    const visibleBottom = viewport.offsetTop + viewport.height;
    const overlap = originalBottom - visibleBottom;
    const bottomSpacing =
      parseFloat(window.getComputedStyle(controls).bottom) - offset;
    const nextOffset =
      viewport.scale === 1 && viewport.height > 0 && overlap > 0
        ? Math.ceil(overlap + bottomSpacing)
        : 0;

    if (
      nextOffset === offset &&
      (nextOffset === 0 || viewport.height === viewportHeight)
    ) {
      return;
    }
    offset = nextOffset;
    viewportHeight = viewport.height;
    if (offset > 0) {
      container.style.setProperty("--bottom-controls-offset", `${offset}px`);
      container.style.setProperty(
        "--bottom-controls-viewport-height",
        `${viewportHeight}px`,
      );
    } else {
      container.style.removeProperty("--bottom-controls-offset");
      container.style.removeProperty("--bottom-controls-viewport-height");
    }
  };

  const scheduleUpdate = () => {
    if (frame === null) {
      frame = window.requestAnimationFrame(update);
    }
  };

  update();
  viewport.addEventListener("resize", scheduleUpdate);
  viewport.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("pageshow", scheduleUpdate);
  window.addEventListener("focus", scheduleUpdate);
  document.addEventListener("visibilitychange", scheduleUpdate);

  return () => {
    viewport.removeEventListener("resize", scheduleUpdate);
    viewport.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("pageshow", scheduleUpdate);
    window.removeEventListener("focus", scheduleUpdate);
    document.removeEventListener("visibilitychange", scheduleUpdate);
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
    }
    container.style.removeProperty("--bottom-controls-offset");
    container.style.removeProperty("--bottom-controls-viewport-height");
  };
};
