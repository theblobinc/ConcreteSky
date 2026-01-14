/**
 * Magic-Grid (ESM build)
 *
 * Vendored from: https://github.com/e-oj/Magic-Grid
 *
 * This file is a small ES module adaptation of the upstream source in
 * [packages/concretesky/js/magicgrid/src]. The upstream project is MIT-licensed.
 * See [packages/concretesky/js/magicgrid/LICENSE].
 */

// ---- Upstream constants (src/constant.js) ----
const POSITIONING_COMPLETE_EVENT = "positionComplete";
const READY_EVENT = "gridReady";
const REPOSITIONING_DELAY = 200;

// ---- Upstream Listener (src/listener.js) ----
class Listener {
  id;
  event;
  handler;

  constructor(id, event, handler) {
    this.id = id;
    this.event = event;
    this.handler = handler;
  }
}

// ---- Upstream EventEmitter (src/event-emitter.js) ----
class EventEmitter {
  listeners;
  #idCounter;

  constructor() {
    this.listeners = [];
    this.#idCounter = 0;
  }

  removeListener(id) {
    const i = this.listeners.findIndex((listener) => listener.id === id);
    if (i !== -1) {
      this.listeners.splice(i, 1);
      return true;
    }
    return false;
  }

  addListener(event, handler) {
    const id = this.#idCounter++;
    this.listeners.push(new Listener(id, event, handler));
    return id;
  }

  emit(event, payload) {
    for (const listener of this.listeners) {
      if (listener.event === event) {
        listener.handler(payload);
      }
    }
  }
}

// ---- Upstream utils (src/utils.js) ----
const checkParams = (config) => {
  const DEFAULT_GUTTER = 25;
  const booleanProps = ["useTransform", "center"];

  if (!config) {
    throw new Error("No config object has been provided.");
  }

  for (const prop of booleanProps) {
    if (typeof config[prop] !== "boolean") {
      config[prop] = true;
    }
  }

  if (typeof config.gutter !== "number") {
    config.gutter = DEFAULT_GUTTER;
  }

  if (!config.container) error("container");
  if (!config.items && !config.static) error("items or static");
};

const error = (prop) => {
  throw new Error(`Missing property '${prop}' in MagicGrid config`);
};

const getMin = (cols) => {
  let min = cols[0];

  for (const col of cols) {
    if (col.height < min.height) min = col;
  }

  return min;
};

// ---- Upstream MagicGrid (src/index.js) ----
export default class MagicGrid extends EventEmitter {
  constructor(config) {
    super();
    checkParams(config);

    if (config.container instanceof HTMLElement) {
      this.container = config.container;
      this.containerClass = config.container.className;
    } else {
      this.containerClass = config.container;
      this.container = document.querySelector(config.container);
    }

    this.static = config.static || false;
    this.size = config.items;
    this.gutter = config.gutter;
    this.maxColumns = config.maxColumns || false;
    this.useMin = config.useMin || false;
    this.useTransform = config.useTransform;
    this.animate = config.animate || false;
    this.center = config.center;
    // Optional: explicit item width to avoid mis-measuring absolutely positioned children.
    this.itemWidth = Number.isFinite(config.itemWidth) ? Number(config.itemWidth) : null;
    this.styledItems = new Set();
    this.resizeObserver = null;
    this.isPositioning = false;
    this._deferredAttempts = 0;
  }

  _containerWidth() {
    if (!this.container) return 0;
    let width = this.container.getBoundingClientRect().width || this.container.clientWidth || 0;
    if (!width && this.container.parentElement) {
      width = this.container.parentElement.getBoundingClientRect().width || this.container.parentElement.clientWidth || 0;
    }
    return width;
  }

  setContainer(container) {
    const previousContainer = this.container;
    this.container = container;

    if (this.resizeObserver) {
      this.resizeObserver.unobserve(previousContainer);
      this.resizeObserver.observe(container);
    }
  }

  initStyles() {
    if (!this.ready()) return;

    this.container.style.position = "relative";
    const items = this.items();

    for (let i = 0; i < items.length; i++) {
      const style = items[i].style;

      // Always ensure positioning is correct.
      style.position = "absolute";

      // If caller provided an explicit width, keep it in sync even for
      // previously-styled items (supports responsive column widths).
      if (this.itemWidth) style.width = `${this.itemWidth}px`;

      if (!this.styledItems.has(items[i])) {
        if (this.animate) {
          style.transition = `${this.useTransform ? "transform" : "top, left"} 0.2s ease`;
        }
        this.styledItems.add(items[i]);
      }
    }
  }

  items() {
    return this.container.children;
  }

  colWidth() {
    // If caller provided an explicit width, trust it.
    if (this.itemWidth) return this.itemWidth + this.gutter;

    const items = this.items();
    if (!items || !items.length) return 350 + this.gutter; // sensible default

    const first = items[0];
    const origPosition = first.style.position;
    const origWidth = first.style.width;

    // Temporarily restore natural flow so width measurement is reliable even if items are absolute.
    first.style.position = "static";
    first.style.width = "auto";

    let width = first.getBoundingClientRect().width || first.offsetWidth || 350;

    first.style.position = origPosition;
    first.style.width = origWidth;

    return width + this.gutter;
  }

  setup() {
    let width = this._containerWidth();
    const colWidth = this.colWidth();
    // Total width for N columns is: N * colWidth - gutter (no trailing gutter).
    // Therefore N = floor((width + gutter) / colWidth).
    let numCols = Math.floor((width + this.gutter) / colWidth) || 1;
    const cols = [];

    if (this.maxColumns && numCols > this.maxColumns) {
      numCols = this.maxColumns;
    }

    for (let i = 0; i < numCols; i++) {
      cols[i] = { height: 0, index: i };
    }

    const wSpace = width - numCols * colWidth + this.gutter;

    return { cols, wSpace, width };
  }

  nextCol(cols, i) {
    if (this.useMin) {
      return getMin(cols);
    }

    return cols[i % cols.length];
  }

  positionItems() {
    if (this.isPositioning) return;

    if (!this.container) return;
    const items = this.items();
    if (!items || !items.length) return;

    this.isPositioning = true;

    let { cols, wSpace, width } = this.setup();
    // If the container isn't measurable yet (hidden panel, not laid out), defer and try again.
    if (!width || width < 2) {
      this.isPositioning = false;
      if (this._deferredAttempts < 10) {
        this._deferredAttempts++;
        requestAnimationFrame(() => this.positionItems());
      }
      return;
    }
    this._deferredAttempts = 0;
    let maxHeight = 0;
    const colWidth = this.colWidth();

    wSpace = this.center ? Math.floor(wSpace / 2) : 0;

    this.initStyles();

    for (let i = 0; i < items.length; i++) {
      const col = this.nextCol(cols, i);
      const item = items[i];
      const topGutter = col.height ? this.gutter : 0;
      const left = col.index * colWidth + wSpace + "px";
      const top = col.height + topGutter + "px";

      if (this.useTransform) {
        item.style.transform = `translate(${left}, ${top})`;
      } else {
        item.style.top = top;
        item.style.left = left;
      }

      col.height += item.getBoundingClientRect().height + topGutter;

      if (col.height > maxHeight) {
        maxHeight = col.height;
      }
    }

    this.container.style.height = maxHeight + this.gutter + "px";
    this.isPositioning = false;
    this.emit(POSITIONING_COMPLETE_EVENT);
  }

  ready() {
    if (this.static) return true;
    return this.items().length >= this.size;
  }

  getReady() {
    const interval = setInterval(() => {
      this.container = document.querySelector(this.containerClass);

      if (this.ready()) {
        clearInterval(interval);
        this.listen();
      }
    }, 100);
  }

  observeContainerResize() {
    if (this.resizeObserver) return;

    this.resizeObserver = new ResizeObserver(() => {
      setTimeout(() => {
        this.positionItems();
      }, REPOSITIONING_DELAY);
    });

    this.resizeObserver.observe(this.container);
  }

  listen() {
    if (this.ready()) {
      window.addEventListener("resize", () => {
        setTimeout(() => {
          this.positionItems();
        }, REPOSITIONING_DELAY);
      });

      this.observeContainerResize();
      this.positionItems();
      this.emit(READY_EVENT);
    } else this.getReady();
  }

  onReady(callback) {
    return this.addListener(READY_EVENT, callback);
  }

  onPositionComplete(callback) {
    return this.addListener(POSITIONING_COMPLETE_EVENT, callback);
  }
}
