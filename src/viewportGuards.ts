/**
 * Блокировки браузерных жестов для игрового режима:
 *  - контекстное меню по правому клику и долгому тапу;
 *  - системная прокрутка страницы, «резинка» и pull-to-refresh
 *    (свайп вниз перезапускал приложение);
 *  - зум двойным тапом и пинчем в Safari.
 *
 * Поля ввода (input/textarea/select/contenteditable) исключены из блокировок,
 * чтобы в них работали выделение, вставка и перетаскивание ползунков.
 */

const EDITABLE_SELECTOR =
  'input, textarea, select, option, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** Элемент, внутри которого браузерные жесты нужно оставить как есть. */
function isInteractiveText(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE_SELECTOR) !== null;
}

function isScrollableAxis(overflow: string, scrollSize: number, clientSize: number): boolean {
  return (
    (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
    scrollSize - clientSize > 1
  );
}

/**
 * Ищет вверх по дереву контейнер с собственной прокруткой (модалки, списки).
 * Внутри таких контейнеров прокрутку не отключаем — от всплытия к документу
 * защищает `overscroll-behavior: none` на html/body.
 */
function hasScrollableAncestor(target: EventTarget | null): boolean {
  let el: Element | null = target instanceof Element ? target : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el instanceof HTMLElement) {
      const style = window.getComputedStyle(el);
      if (
        isScrollableAxis(style.overflowY, el.scrollHeight, el.clientHeight) ||
        isScrollableAxis(style.overflowX, el.scrollWidth, el.clientWidth)
      ) {
        return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

/** Устанавливает блокировки и возвращает функцию их снятия. */
export function installViewportGuards(): () => void {
  const blockContextMenu = (e: MouseEvent) => {
    if (isInteractiveText(e.target)) return;
    e.preventDefault();
  };

  const blockDragStart = (e: DragEvent) => {
    if (isInteractiveText(e.target)) return;
    e.preventDefault();
  };

  // Свайпы вне прокручиваемых блоков: прокрутка страницы, «резинка», pull-to-refresh.
  const blockTouchMove = (e: TouchEvent) => {
    if (isInteractiveText(e.target)) return;
    if (hasScrollableAncestor(e.target)) return;
    if (e.cancelable) e.preventDefault();
  };

  // Колесо мыши вне прокручиваемых блоков (Ctrl+колесо — зум браузера, не трогаем).
  const blockWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return;
    if (isInteractiveText(e.target)) return;
    if (hasScrollableAncestor(e.target)) return;
    if (e.cancelable) e.preventDefault();
  };

  // Зум двойным тапом.
  const blockDoubleTapZoom = (e: MouseEvent) => {
    if (isInteractiveText(e.target)) return;
    e.preventDefault();
  };

  // Пинч-зум в Safari (нестандартные gesture-события).
  const blockGesture = (e: Event) => {
    if (e.cancelable) e.preventDefault();
  };

  document.addEventListener("contextmenu", blockContextMenu);
  document.addEventListener("dragstart", blockDragStart);
  document.addEventListener("touchmove", blockTouchMove, { passive: false });
  document.addEventListener("wheel", blockWheel, { passive: false });
  document.addEventListener("dblclick", blockDoubleTapZoom);
  document.addEventListener("gesturestart", blockGesture, { passive: false });
  document.addEventListener("gesturechange", blockGesture, { passive: false });
  document.addEventListener("gestureend", blockGesture, { passive: false });

  return () => {
    document.removeEventListener("contextmenu", blockContextMenu);
    document.removeEventListener("dragstart", blockDragStart);
    document.removeEventListener("touchmove", blockTouchMove);
    document.removeEventListener("wheel", blockWheel);
    document.removeEventListener("dblclick", blockDoubleTapZoom);
    document.removeEventListener("gesturestart", blockGesture);
    document.removeEventListener("gesturechange", blockGesture);
    document.removeEventListener("gestureend", blockGesture);
  };
}
