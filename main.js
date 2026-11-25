"use strict";

const { Plugin, Notice, setIcon, Menu, PluginSettingTab, Setting, MarkdownRenderer, Component, MarkdownRenderChild } = require("obsidian");

const DEFAULT_SETTINGS = {
  // false: click selects a cell, a second click (or Enter) edits it.
  // true:  a single click edits the cell immediately ("quick text edit").
  quickEdit: false
};

const TABLE_CELL_W = 140;
const TABLE_CELL_H = 48;
const MIN_W = 50;
const MIN_H = 28;
const MAX_LINK_SUGGESTIONS = 20;

/** The metadata comment. Sizes were 0.2.x; merges are appended as one extra
 *  key, so a block written by an older version still parses. merge= entries
 *  are `r,c,rowSpan,colSpan` separated by `|`. */
const META_RE = /^\s*<!--\s*tk:cols=([\d.,\s]*);rows=([\d.,\s]*)(?:;merge=([\d.,| \t]*))?\s*-->\s*$/;

/** Markdown tables cannot express colspan/rowspan, so merged regions are kept
 *  in the same hidden comment as the sizes. Every other cell of a merged
 *  region is written as an empty cell, which keeps the block readable as a
 *  plain markdown table. */
function rectsOverlap(a, b) {
  return a.r < b.r + b.rs && b.r < a.r + a.rs && a.c < b.c + b.cs && b.c < a.c + a.cs;
}

/** Position of old index `i` after moving the item at `from` to `to`. */
function movePos(i, from, to) {
  if (i === from) return to;
  if (from < to) return i > from && i <= to ? i - 1 : i;
  return i >= to && i < from ? i + 1 : i;
}

/** Image types we can store as attachments, keyed by MIME type. */
const IMAGE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg"
};

function extForImage(type) {
  const t = (type || "").toLowerCase().split(";")[0].trim();
  return IMAGE_EXT[t] || "png";
}

/** "Pasted image 20261125201345" — matches Obsidian's own attachment naming. */
function attachmentStamp() {
  const moment = window.moment;
  if (moment && typeof moment === "function") return moment().format("YYYYMMDDHHmmss");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Decode base64 without atob (it's brand-checked in some environments) and
 *  tolerant of whitespace and the URL-safe alphabet. */
function base64ToBytes(text) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(text || "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const ch of clean) {
    if (ch === "=") break;
    const value = chars.indexOf(ch);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

/** Decode a data: URL image into bytes. Returns null for anything else. */
function dataUrlImage(src) {
  const m = /^data:([^;,]*)((?:;[^,]*)?),([\s\S]*)$/i.exec(src || "");
  if (!m) return null;
  const type = (m[1] || "image/png").toLowerCase();
  if (!/^image\//.test(type)) return null;
  const meta = m[2] || "";
  let bytes;
  try {
    if (/;base64/i.test(meta)) bytes = base64ToBytes(m[3]);
    else bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
  } catch {
    return null;
  }
  return { bytes: bytes.buffer, type };
}

function sumArr(a) {
  return a.reduce((s, n) => s + n, 0);
}

/** Split a markdown table row on cell separators, while leaving escaped pipes,
 *  wikilink aliases like [[Page|Alias]], inline code, and markdown link text
 *  intact. The serializer still escapes pipes, but this keeps hand-written
 *  table blocks from falling apart. */
function splitTableRow(inner) {
  const cells = [];
  let cur = "";
  let inCode = false;
  let mathFence = null;
  let wikiDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    const prev = inner[i - 1];
    const next = inner[i + 1];

    if (ch === "`" && prev !== "\\" && !mathFence) inCode = !inCode;
    if (!inCode) {
      if (ch === "$" && prev !== "\\") {
        const fence = next === "$" ? "$$" : "$";
        if (!mathFence) {
          mathFence = fence;
          cur += fence;
          if (fence === "$$") i++;
          continue;
        }
        if (mathFence === fence) {
          mathFence = null;
          cur += fence;
          if (fence === "$$") i++;
          continue;
        }
      }
      if (mathFence) {
        cur += ch;
        continue;
      }
      if (ch === "[" && next === "[") {
        wikiDepth++;
        cur += ch + next;
        i++;
        continue;
      }
      if (ch === "]" && next === "]" && wikiDepth > 0) {
        wikiDepth--;
        cur += ch + next;
        i++;
        continue;
      }
      if (ch === "[" && prev !== "\\" && wikiDepth === 0) bracketDepth++;
      else if (ch === "]" && prev !== "\\" && bracketDepth > 0) bracketDepth--;
    }

    if (ch === "|" && prev !== "\\" && !inCode && wikiDepth === 0 && bracketDepth === 0) {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Parse a GitHub-style markdown table into a 2-D array of cell strings.
 *  Ignores the |---| separator line and any non-pipe lines (e.g. our size comment). */
function parseMdTable(text) {
  const lines = text.split("\n").filter((l) => l.trim().startsWith("|"));
  const rows = [];
  for (const line of lines) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-")) continue;
    const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    rows.push(
      splitTableRow(inner)
        // Decode escaped pipes and our <br> line-break encoding back into the
        // raw multi-line text the cell edits as.
        .map((c) => c.trim().replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n"))
    );
  }
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push("");
  return rows;
}

function mdFromCells(cells, align) {
  // Pipe tables can't contain a literal pipe or newline, so escape pipes and
  // encode in-cell line breaks (Cmd+Enter) as <br>, which is valid table markup.
  const esc = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const row = (r) => "| " + r.map((c) => esc(c) || "   ").join(" | ") + " |";
  // Column alignment lives in the separator row (portable markdown):
  // :---: center, ---: right, --- default/left.
  const sep = cells[0].map((_, c) => {
    const a = align && align[c];
    if (a === "center") return " :---: ";
    if (a === "right") return " ---: ";
    return " --- ";
  });
  return [row(cells[0]), "|" + sep.join("|") + "|", ...cells.slice(1).map(row)].join("\n");
}

/** Read per-column alignment from the table's separator row, if present. */
function parseAlign(text) {
  for (const line of text.split("\n")) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-")) {
      return line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => {
          const s = c.trim();
          const l = s.startsWith(":");
          const r = s.endsWith(":");
          if (l && r) return "center";
          if (r) return "right";
          return null;
        });
    }
  }
  return null;
}

/** Pull stored column/row sizes (and merged regions) out of the metadata
 *  comment, if present. */
function parseMeta(text) {
  for (const line of text.split("\n")) {
    const m = line.match(META_RE);
    if (m) {
      const nums = (s) =>
        s.split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);
      const merges = [];
      for (const raw of (m[3] || "").split("|")) {
        const parts = raw.split(",").map((n) => Number(n.trim()));
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) continue;
        const [r, c, rs, cs] = parts;
        if (r < 0 || c < 0 || rs < 1 || cs < 1) continue;
        if (rs === 1 && cs === 1) continue;
        merges.push({ r, c, rs, cs });
      }
      return { cols: nums(m[1]), rows: nums(m[2]), merges };
    }
  }
  return null;
}

function parseSizes(text) {
  const meta = parseMeta(text);
  return meta ? { cols: meta.cols, rows: meta.rows } : null;
}

class TableWidget {
  constructor(plugin, source, el, ctx) {
    this.plugin = plugin;
    this.source = source;
    this.el = el;
    this.ctx = ctx;
    this.cells = [["", ""], ["", ""]];
    this.colW = [];
    this.rowH = [];
    this.colAlign = [];
    // Merged regions: { r, c, rs, cs } with the origin cell at (r, c).
    // mergeAt[r][c] points at the region covering a grid position (or is
    // null); tdMap[r][c] is the <td> that paints it (the region's origin cell).
    this.merges = [];
    this.mergeAt = [];
    this.tdMap = [];
    this.editingCell = null;
    this.editingPos = null;
    this.dirty = false;
    this.rootEl = null;
    this.tableEl = null;
    this.addColEl = null;
    this.addRowEl = null;
    this.colHandles = [];
    this.rowHandles = [];
    this.colDividers = [];
    this.rowDividers = [];
    this.insertColDots = [];
    this.insertRowDots = [];
    this.insertLineEl = null;
    this.resizeObs = null;
    this.selected = null;
    this.deleteBtnEl = null;
    this.deleteTableEl = null;
    this.lineSelOutside = null;
    this.lineSelKey = null;
    this.cellSel = null;
    this.cellSelOutside = null;
    this.cellSelKey = null;
    this.cellSelBox = null;
    // Owns the child components spawned by markdown cell rendering (embeds,
    // dataview, etc.) so they unload when the widget re-renders or tears down,
    // instead of leaking onto the plugin for its whole lifetime.
    this.mdComponent = null;
  }

  get doc() {
    return this.el.ownerDocument;
  }

  /** Tear down everything this widget owns. Called when Obsidian unloads the
   *  block (re-render, view close, plugin unload) via the render child below. */
  destroy() {
    if (this.resizeObs) {
      this.resizeObs.disconnect();
      this.resizeObs = null;
    }
    this.closeInternalLinkSuggest();
    if (this.mdComponent) {
      this.mdComponent.unload();
      this.mdComponent = null;
    }
  }

  isEditing() {
    return this.editingCell !== null;
  }

  /** Reading view is display-only: no live editor sits behind the block, so the
   *  table renders static (no chrome, no click-to-edit). Obsidian has changed
   *  the exact Live Preview wrapper classes over time, so prefer known
   *  CodeMirror/editing ancestors before falling back to preview/export. */
  isReadingView() {
    const editRoot = this.el.closest(
      ".markdown-source-view, .cm-editor, .cm-content, .cm-contentContainer, .cm-scroller, .cm-preview-code-block, .cm-embed-block"
    );
    if (editRoot) return false;
    const previewRoot = this.el.closest(".markdown-reading-view, .markdown-preview-view");
    if (previewRoot) return true;
    return true;
  }

  loadSizes() {
    const cols = this.cells[0].length;
    const rows = this.cells.length;
    const stored = parseMeta(this.source);
    const pc = stored && stored.cols;
    const pr = stored && stored.rows;
    this.colW = Array.isArray(pc) && pc.length === cols ? pc.map((n) => Math.max(MIN_W, n)) : [];
    this.rowH = Array.isArray(pr) && pr.length === rows ? pr.map((n) => Math.max(MIN_H, n)) : [];
    if (this.colW.length !== cols) this.colW = Array(cols).fill(TABLE_CELL_W);
    if (this.rowH.length !== rows) this.rowH = Array(rows).fill(TABLE_CELL_H);
  }

  loadAlign() {
    const cols = this.cells[0].length;
    const a = parseAlign(this.source);
    this.colAlign = Array.isArray(a) && a.length === cols ? a : Array(cols).fill(null);
  }

  /** Read the stored merged regions and keep only the ones that still fit the
   *  table. A merge whose covered cells hold text is dropped rather than
   *  hiding that text (that only happens when the block was edited by hand in
   *  source mode, since we always blank the covered cells on merge). */
  loadMerges() {
    const rows = this.cells.length;
    const cols = this.cells[0].length;
    const meta = parseMeta(this.source);
    const used = Array.from({ length: rows }, () => Array(cols).fill(false));
    const out = [];
    for (const m of (meta && meta.merges) || []) {
      const r = m.r;
      const c = m.c;
      const rs = m.rs;
      const cs = m.cs;
      if (r < 0 || c < 0 || r + rs > rows || c + cs > cols) continue;
      let ok = true;
      for (let ri = r; ri < r + rs && ok; ri++) {
        for (let ci = c; ci < c + cs; ci++) {
          if (used[ri][ci] || (ri !== r || ci !== c) && (this.cells[ri][ci] || "").trim() !== "") {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      for (let ri = r; ri < r + rs; ri++) for (let ci = c; ci < c + cs; ci++) used[ri][ci] = true;
      out.push({ r, c, rs, cs });
    }
    this.merges = out;
    this.buildMergeIndex();
  }

  /** Index merged regions by grid position. */
  buildMergeIndex() {
    const rows = this.cells.length;
    const cols = this.cells[0].length;
    this.mergeAt = Array.from({ length: rows }, () => Array(cols).fill(null));
    for (const m of this.merges) {
      for (let ri = m.r; ri < m.r + m.rs; ri++) {
        for (let ci = m.c; ci < m.c + m.cs; ci++) this.mergeAt[ri][ci] = m;
      }
    }
  }

  /** The merged region covering a grid position, if any. */
  mergeFor(r, c) {
    return (this.mergeAt[r] && this.mergeAt[r][c]) || null;
  }

  /** True when (r, c) is part of a merge but is not its origin cell. */
  isCovered(r, c) {
    const m = this.mergeFor(r, c);
    return !!m && (m.r !== r || m.c !== c);
  }

  /** Grid position of the cell that owns (r, c) — the merge origin for a
   *  covered position, otherwise the position itself. */
  originOf(r, c) {
    const m = this.mergeFor(r, c);
    return m ? { r: m.r, c: m.c } : { r, c };
  }

  /** The <td> that paints grid position (r, c), resolving merges. */
  tdAt(r, c) {
    const o = this.originOf(r, c);
    return (this.tdMap[o.r] && this.tdMap[o.r][o.c]) || null;
  }

  /** Column geometry in table-local pixels. Derived from the stored widths
   *  (which are exactly what the colgroup is given) so it stays correct when
   *  row 0 has merged cells and DOM cell indexes no longer map to columns. */
  colBounds() {
    const cols = (this.cells[0] && this.cells[0].length) || 0;
    const widths = [];
    const lefts = [];
    let x = 0;
    for (let c = 0; c < cols; c++) {
      const w = this.colW[c] || TABLE_CELL_W;
      lefts[c] = x;
      widths[c] = w;
      x += w;
    }
    return { lefts, widths, total: x };
  }

  /** Apply per-column text alignment to the cells. A merged cell follows the
   *  alignment of its origin column. */
  applyAlign() {
    const t = this.tableEl;
    if (!t) return;
    Array.from(t.rows).forEach((tr) => {
      Array.from(tr.cells).forEach((td) => {
        const c = td._btC;
        td.style.textAlign = c == null ? "" : this.colAlign[c] || "";
      });
    });
  }

  render() {
    const parsed = parseMdTable(this.source);
    if (parsed) this.cells = parsed;
    this.closeInternalLinkSuggest();
    this.editingCell = null;
    this.loadSizes();
    this.loadAlign();
    this.loadMerges();
    this.clearLineSelection();
    this.clearCellSelection();
    this.el.empty();
    this.cellSelBox = null; // detached with the old root; recreated on demand
    // Fresh markdown host: unload the previous render's child components (the
    // old cell DOM is about to be discarded by empty()) and start a new one.
    if (this.mdComponent) this.mdComponent.unload();
    this.mdComponent = new Component();
    this.mdComponent.load();
    this.el.addClass("tk-block");
    this.readOnly = this.isReadingView();
    this.el.toggleClass("cp-table-readonly", this.readOnly);

    const scroll = this.el.createDiv({ cls: "cp-table-scroll" });
    const root = (this.rootEl = scroll.createDiv({ cls: "cp-table-root" }));
    const table = (this.tableEl = root.createEl("table", { cls: "cp-table" }));
    const colgroup = table.createEl("colgroup");
    for (let c = 0; c < this.cells[0].length; c++) colgroup.createEl("col");

    const rows = this.cells.length;
    const cols = this.cells[0].length;
    // Only the origin cell of a merged region is created; covered positions
    // are painted by it (rowspan/colspan) and still resolve through tdMap.
    this.tdMap = Array.from({ length: rows }, () => Array(cols).fill(null));
    this.cells.forEach((row, r) => {
      const tr = table.createEl("tr");
      row.forEach((cellText, c) => {
        if (this.isCovered(r, c)) return;
        const m = this.mergeFor(r, c);
        const td = tr.createEl("td");
        if (m && m.rs > 1) td.rowSpan = m.rs;
        if (m && m.cs > 1) td.colSpan = m.cs;
        td._btR = r;
        td._btC = c;
        this.tdMap[r][c] = td;
        this.bindCell(td, r, c, cellText);
      });
    });
    for (const m of this.merges) {
      const td = this.tdMap[m.r][m.c];
      for (let ri = m.r; ri < m.r + m.rs; ri++) {
        for (let ci = m.c; ci < m.c + m.cs; ci++) this.tdMap[ri][ci] = td;
      }
    }
    this.applySizes();
    this.applyAlign();

    // Reading view: static table only. Cells are rendered above with no edit
    // listeners (see bindCell); skip all the interactive chrome below.
    if (this.readOnly) return;

    this.addColEl = root.createDiv({ cls: "cp-table-add cp-table-add-col", attr: { "aria-label": "Add column" } });
    setIcon(this.addColEl, "plus");
    this.addColEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.flushEdit();
      this.cells.forEach((row) => row.push(""));
      this.colW.push(TABLE_CELL_W);
      this.colAlign.push(null);
      this.save();
    });

    this.addRowEl = root.createDiv({ cls: "cp-table-add cp-table-add-row", attr: { "aria-label": "Add row" } });
    setIcon(this.addRowEl, "plus");
    this.addRowEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.flushEdit();
      this.cells.push(this.cells[0].map(() => ""));
      this.rowH.push(TABLE_CELL_H);
      this.save();
    });

    this.colHandles = [];
    this.rowHandles = [];
    this.colDividers = [];
    this.rowDividers = [];
    // A divider sits on every column's right edge and every row's bottom edge —
    // including the last column and last row, so the rightmost/bottommost borders
    // are resizable too (previously impossible).
    for (let c = 0; c < cols; c++) {
      const h = root.createDiv({ cls: "cp-table-handle cp-table-handle-col", attr: { "aria-label": "Drag to reorder column" } });
      this.bindReorder(h, "col", c);
      this.colHandles.push(h);
      const d = root.createDiv({ cls: "cp-table-divider cp-table-divider-col" });
      this.bindResize(d, "col", c);
      this.colDividers.push(d);
    }
    for (let r = 0; r < rows; r++) {
      const h = root.createDiv({ cls: "cp-table-handle cp-table-handle-row", attr: { "aria-label": "Drag to reorder row" } });
      this.bindReorder(h, "row", r);
      this.rowHandles.push(h);
      const d = root.createDiv({ cls: "cp-table-divider cp-table-divider-row" });
      this.bindResize(d, "row", r);
      this.rowDividers.push(d);
    }

    this.insertColDots = [];
    this.insertRowDots = [];
    this.insertLineEl = root.createDiv({ cls: "cp-insert-line" });
    this.insertLineEl.hide();
    for (let c = 0; c < cols - 1; c++) {
      const dot = root.createDiv({ cls: "cp-insert cp-insert-col", attr: { "aria-label": "Insert column here" } });
      setIcon(dot, "plus");
      this.bindInsert(dot, "col", c);
      this.insertColDots.push(dot);
    }
    for (let r = 0; r < rows - 1; r++) {
      const dot = root.createDiv({ cls: "cp-insert cp-insert-row", attr: { "aria-label": "Insert row here" } });
      setIcon(dot, "plus");
      this.bindInsert(dot, "row", r);
      this.insertRowDots.push(dot);
    }

    // Delete-table button: sits at the block's top-right next to Obsidian's
    // "edit this block" control and is styled like a standard clickable icon
    // (grey bin, grey hover fill). Lives on the block el, not the table chrome.
    this.deleteTableEl = this.el.createDiv({
      cls: "cp-delete-block clickable-icon",
      attr: { "aria-label": "Delete table" }
    });
    setIcon(this.deleteTableEl, "trash-2");
    this.deleteTableEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      this.deleteTable();
    });

    this.bindChromeTracker();
    this.hideChrome();
    // Reposition the chrome whenever the table's geometry changes — e.g. when
    // the user switches themes (different cell padding/fonts reflow the table),
    // web fonts finish loading, or the container resizes. Without this the
    // handles/dividers stay pinned to the old layout and drift out of line.
    if (this.resizeObs) this.resizeObs.disconnect();
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.tableEl);
    window.requestAnimationFrame(() => this.layout());
  }

  // --- proximity-based chrome visibility ---
  bindChromeTracker() {
    const root = this.rootEl;
    if (!root) return;
    root.addEventListener("pointermove", (e) => this.updateChrome(e));
    root.addEventListener("pointerleave", () => {
      if (!this.isEditing()) this.hideChrome();
    });
  }

  updateChrome(e) {
    const t = this.tableEl;
    if (!t || !t.isConnected) return;
    const rect = t.getBoundingClientRect();
    const M = 48;
    if (e.clientX < rect.left - M || e.clientX > rect.right + M || e.clientY < rect.top - M || e.clientY > rect.bottom + M) {
      this.hideChrome();
      return;
    }
    const x = Math.min(Math.max(e.clientX, rect.left + 1), rect.right - 1);
    const y = Math.min(Math.max(e.clientY, rect.top + 1), rect.bottom - 1);
    // Column index from geometry, not from row 0's cells: merged cells make
    // row.cells indexes meaningless as column numbers.
    const colGeo = this.colBounds();
    const localX = x - rect.left;
    let c = 0;
    let r = 0;
    for (let i = 0; i < colGeo.widths.length; i++) {
      if (localX >= colGeo.lefts[i] && localX <= colGeo.lefts[i] + colGeo.widths[i]) {
        c = i;
        break;
      }
      c = i;
    }
    for (let i = 0; i < t.rows.length; i++) {
      const rr = t.rows[i].getBoundingClientRect();
      if (y >= rr.top && y <= rr.bottom) {
        r = i;
        break;
      }
    }
    const cols = this.cells[0].length;
    const rows = this.cells.length;
    this.colHandles.forEach((h, i) => h.toggleClass("is-visible", i === c));
    this.rowHandles.forEach((h, i) => h.toggleClass("is-visible", i === r));
    this.addColEl && this.addColEl.toggleClass("is-visible", c === cols - 1);
    this.addRowEl && this.addRowEl.toggleClass("is-visible", r === rows - 1);
    this.insertColDots.forEach((d, i) => d.toggleClass("is-visible", i === c - 1 || i === c));
    this.insertRowDots.forEach((d, i) => d.toggleClass("is-visible", i === r - 1 || i === r));
  }

  hideChrome() {
    const all = [...this.colHandles, ...this.rowHandles, ...this.insertColDots, ...this.insertRowDots];
    if (this.addColEl) all.push(this.addColEl);
    if (this.addRowEl) all.push(this.addRowEl);
    for (const el of all) el.removeClass("is-visible");
    this.insertLineEl && this.insertLineEl.hide();
  }

  // --- insert between rows/columns ---
  bindInsert(dot, axis, boundary) {
    dot.addEventListener("pointerenter", () => this.showInsertLine(axis, boundary));
    dot.addEventListener("pointerleave", () => this.insertLineEl && this.insertLineEl.hide());
    dot.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      this.flushEdit();
      this.insertLineEl && this.insertLineEl.hide();
      if (axis === "col") {
        this.cells.forEach((row) => row.splice(boundary + 1, 0, ""));
        this.colW.splice(boundary + 1, 0, TABLE_CELL_W);
        this.colAlign.splice(boundary + 1, 0, null);
        this.mergesAfterInsert("col", boundary + 1);
      } else {
        this.cells.splice(boundary + 1, 0, this.cells[0].map(() => ""));
        this.rowH.splice(boundary + 1, 0, TABLE_CELL_H);
        this.mergesAfterInsert("row", boundary + 1);
      }
      this.save();
    });
  }

  showInsertLine(axis, boundary) {
    const t = this.tableEl;
    const line = this.insertLineEl;
    if (!t || !line) return;
    if (axis === "col") {
      const geo = this.colBounds();
      if (!geo.widths.length) return;
      line.style.left = `${geo.lefts[boundary] + geo.widths[boundary] - 1.5}px`;
      line.style.top = "0px";
      line.style.width = "3px";
      line.style.height = `${t.offsetHeight}px`;
    } else {
      const tr = t.rows[boundary];
      if (!tr) return;
      line.style.top = `${tr.offsetTop + tr.offsetHeight - 1.5}px`;
      line.style.left = "0px";
      line.style.height = "3px";
      line.style.width = `${t.offsetWidth}px`;
    }
    line.show();
  }

  // --- sizing ---
  applySizes() {
    const t = this.tableEl;
    if (!t) return;
    t.querySelectorAll("col").forEach((c, i) => {
      c.style.width = `${this.colW[i] || TABLE_CELL_W}px`;
    });
    t.style.width = `${sumArr(this.colW)}px`;
    Array.from(t.rows).forEach((tr, r) => {
      tr.style.height = `${this.rowH[r] || TABLE_CELL_H}px`;
    });
  }

  /** Position the +/reorder/divider chrome from measured geometry. Columns
   *  come from the stored widths (row 0 may hold merged cells, so DOM cells
   *  don't line up with columns); rows come from the rendered <tr> boxes. */
  layout() {
    const t = this.tableEl;
    if (!t || !t.isConnected) return;
    if (this.cellSel) this.positionCellSelBox();
    const tw = t.offsetWidth;
    const th = t.offsetHeight;
    const geo = this.colBounds();
    if (this.addColEl) {
      this.addColEl.style.left = `${tw + 6}px`;
      this.addColEl.style.top = "0px";
      this.addColEl.style.height = `${th}px`;
    }
    if (this.addRowEl) {
      this.addRowEl.style.top = `${th + 6}px`;
      this.addRowEl.style.left = "0px";
      this.addRowEl.style.width = `${tw}px`;
    }
    this.colHandles.forEach((h, i) => {
      if (geo.widths[i] == null) return;
      h.style.left = `${geo.lefts[i] + geo.widths[i] / 2}px`;
    });
    this.colDividers.forEach((d, i) => {
      if (geo.widths[i] == null) return;
      d.style.left = `${geo.lefts[i] + geo.widths[i] - 3}px`;
      d.style.top = "0px";
      d.style.height = `${th}px`;
    });
    this.rowHandles.forEach((h, r) => {
      const tr = t.rows[r];
      if (tr) h.style.top = `${tr.offsetTop + tr.offsetHeight / 2}px`;
    });
    this.rowDividers.forEach((d, r) => {
      const tr = t.rows[r];
      if (tr) {
        d.style.top = `${tr.offsetTop + tr.offsetHeight - 3}px`;
        d.style.left = "0px";
        d.style.width = `${tw}px`;
      }
    });
    this.insertColDots.forEach((d, i) => {
      if (geo.widths[i] == null) return;
      d.style.left = `${geo.lefts[i] + geo.widths[i]}px`;
      d.style.top = "-12px";
    });
    this.insertRowDots.forEach((d, r) => {
      const tr = t.rows[r];
      if (tr) {
        d.style.top = `${tr.offsetTop + tr.offsetHeight}px`;
        d.style.left = "-12px";
      }
    });
    this.positionDeleteBtn();
  }

  /** Drag a divider to resize the column left of / row above it. */
  bindResize(div, axis, index) {
    div.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      div.addClass("is-resizing");
      const startX = e.clientX;
      const startY = e.clientY;
      const startSize = axis === "col" ? this.colW[index] : this.rowH[index];
      const onMove = (ev) => {
        if (axis === "col") {
          this.colW[index] = Math.max(MIN_W, Math.round(startSize + (ev.clientX - startX)));
        } else {
          this.rowH[index] = Math.max(MIN_H, Math.round(startSize + (ev.clientY - startY)));
        }
        this.applySizes();
        this.layout();
      };
      const onUp = () => {
        div.removeEventListener("pointermove", onMove);
        div.removeClass("is-resizing");
        this.save();
      };
      div.addEventListener("pointermove", onMove);
      div.addEventListener("pointerup", onUp, { once: true });
    });
  }

  // --- merged cells ---
  /** Sort regions into reading order so the stored comment stays stable, and
   *  guard the invariant that every region fits the current table. */
  sortMerges() {
    const rows = this.cells.length;
    const cols = (this.cells[0] && this.cells[0].length) || 0;
    this.merges = this.merges.filter(
      (m) =>
        m.rs >= 1 &&
        m.cs >= 1 &&
        m.r >= 0 &&
        m.c >= 0 &&
        m.r + m.rs <= rows &&
        m.c + m.cs <= cols &&
        (m.rs > 1 || m.cs > 1)
    );
    this.merges.sort((a, b) => a.r - b.r || a.c - b.c || b.rs - a.rs || b.cs - a.cs);
    this.buildMergeIndex();
  }

  /** Merge the current cell selection into one cell. Content of every cell in
   *  the block is kept, in reading order, one line each, in the top-left cell;
   *  the cells it covers are blanked (markdown has nowhere else to put them). */
  mergeSelection() {
    if (!this.cellSel) return;
    const { rA, rB, cA, cB } = this.selRect();
    if (rA === rB && cA === cB) return;
    this.flushEdit();
    const target = { r: rA, c: cA, rs: rB - rA + 1, cs: cB - cA + 1 };
    const parts = [];
    for (let r = rA; r <= rB; r++) {
      for (let c = cA; c <= cB; c++) {
        const text = (this.cells[r][c] || "").trim();
        if (text) parts.push(text);
      }
    }
    // Overlapping merges are dissolved first; their text is part of `parts`.
    this.merges = this.merges.filter((m) => !rectsOverlap(m, target));
    for (let r = rA; r <= rB; r++) {
      for (let c = cA; c <= cB; c++) this.cells[r][c] = "";
    }
    this.cells[rA][cA] = parts.join("\n");
    this.merges.push(target);
    this.sortMerges();
    this.clearCellSelection();
    this.dirty = true;
    this.save();
  }

  /** Split the merged region whose origin is (r, c). Its text stays in the
   *  top-left cell; the cells that were covered stay empty. */
  unmergeAt(r, c) {
    const m = this.mergeFor(r, c);
    if (!m || (m.rs === 1 && m.cs === 1)) return;
    this.flushEdit();
    this.merges = this.merges.filter((x) => x !== m);
    this.sortMerges();
    this.clearCellSelection();
    this.dirty = true;
    this.save();
  }

  /** A line was inserted before index `at`: shift regions after it and grow
   *  any region the new line was inserted into. */
  mergesAfterInsert(axis, at) {
    const isCol = axis === "col";
    for (const m of this.merges) {
      const start = isCol ? m.c : m.r;
      const len = isCol ? m.cs : m.rs;
      if (start >= at) {
        if (isCol) m.c++;
        else m.r++;
      } else if (start + len > at) {
        if (isCol) m.cs++;
        else m.rs++;
      }
    }
    this.sortMerges();
  }

  /** A line at `index` was deleted: move/shrink regions and drop the ones
   *  that collapse to a single cell. */
  mergesAfterDelete(axis, index) {
    const isCol = axis === "col";
    const next = [];
    for (const m of this.merges) {
      const key = isCol ? "c" : "r";
      const lenKey = isCol ? "cs" : "rs";
      const start = m[key];
      const len = m[lenKey];
      if (len === 1) {
        // One line thick on this axis: the deleted line either takes the whole
        // region with it (its text lived on that line) or lies outside it.
        if (index === start) continue;
        if (index < start) m[key]--;
        next.push(m);
      } else if (index < start) {
        m[key]--;
        next.push(m);
      } else if (index < start + len) {
        m[lenKey]--;
        if (m.rs > 1 || m.cs > 1) next.push(m);
      } else {
        next.push(m);
      }
    }
    this.merges = next;
    this.sortMerges();
  }

  /** A row/column was dragged from `from` to `to`: keep regions that still
   *  describe a contiguous rectangle after the move, drop the rest. */
  mergesAfterMove(axis, from, to) {
    const isCol = axis === "col";
    const next = [];
    for (const m of this.merges) {
      const key = isCol ? "c" : "r";
      const lenKey = isCol ? "cs" : "rs";
      const start = m[key];
      const len = m[lenKey];
      if (len === 1) {
        m[key] = movePos(start, from, to);
        next.push(m);
        continue;
      }
      // Moving a line out of the middle of a region, or dropping a line into
      // it, can't stay rectangular.
      if (from >= start && from < start + len) continue;
      const positions = [];
      for (let i = start; i < start + len; i++) positions.push(movePos(i, from, to));
      let contiguous = true;
      for (let i = 1; i < positions.length; i++) {
        if (positions[i] !== positions[0] + i) contiguous = false;
      }
      if (!contiguous) continue;
      m[key] = positions[0];
      next.push(m);
    }
    this.merges = next;
    this.sortMerges();
  }

  // --- pasted images ---
  /** Save an image from the clipboard into the vault's attachment folder and
   *  insert an embed at the caret. Cells store markdown text, so the embed
   *  survives the commit to the file (a pasted <img> did not). */
  async handleCellPaste(td, r, c, evt) {
    const dt = evt.clipboardData;
    if (!dt) return;
    const files = this.imageFilesFrom(dt);
    // Images copied from a web page arrive as HTML, not as files.
    const html = !files.length && dt.getData ? dt.getData("text/html") : "";
    const srcs = files.length ? [] : this.imageSrcsFromHtml(html);
    // Plain text (including an existing ![[embed]]) pastes normally.
    if (!files.length && !srcs.length) return;

    evt.preventDefault();
    evt.stopPropagation();

    const sel = window.getSelection();
    const savedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const lines = await this.imageEmbedsFrom(files, srcs);
    if (!lines || !lines.length) return;
    const text = lines.join("\n");
    if (this.editingCell === td) {
      this.insertTextAtCaret(td, text, savedRange);
    } else {
      // The edit ended while the file was being written: keep the image by
      // appending the embed to the cell instead of dropping it.
      this.appendToCell(r, c, text);
    }
  }

  /** Drop an image file on a cell. Dropping is not editing, so the embed is
   *  appended to the cell's text and saved; without this the browser (and
   *  Obsidian) would attach the file and lose the reference. */
  async handleCellDrop(td, r, c, evt) {
    const dt = evt.dataTransfer;
    if (!dt) return;
    const files = this.imageFilesFrom(dt);
    const srcs = files.length ? [] : this.imageSrcsFromHtml(dt.getData ? dt.getData("text/html") : "");
    if (!files.length && !srcs.length) return;
    evt.preventDefault();
    evt.stopPropagation();
    const lines = await this.imageEmbedsFrom(files, srcs);
    if (!lines || !lines.length) return;
    const text = lines.join("\n");
    if (this.editingCell === td) this.insertTextAtCaret(td, text, null);
    else this.appendToCell(r, c, text);
  }

  imageFilesFrom(dt) {
    const files = [];
    if (dt.files && dt.files.length) {
      for (const f of Array.from(dt.files)) {
        if (f && /^image\//i.test(f.type || "")) files.push(f);
      }
    }
    if (!files.length && dt.items && dt.items.length) {
      for (const item of Array.from(dt.items)) {
        if (item.kind === "file" && /^image\//i.test(item.type || "")) {
          const f = item.getAsFile ? item.getAsFile() : null;
          if (f) files.push(f);
        }
      }
    }
    return files;
  }

  /** Save every image and return the embed lines, or null if saving failed. */
  async imageEmbedsFrom(files, srcs) {
    const lines = [];
    try {
      for (const file of files.slice(0, 20)) lines.push(await this.savePastedImage(file));
      for (const src of srcs.slice(0, 20)) {
        if (/^data:/i.test(src)) {
          // Inline image data: store it as a real attachment, never inline the
          // whole data URL in the note.
          const data = dataUrlImage(src);
          if (data) lines.push(await this.saveImageBytes(data.bytes, data.type));
        } else if (/^blob:/i.test(src)) {
          // Some apps hand over a blob: URL for the copied picture.
          const res = await fetch(src);
          const type = res.headers.get("content-type") || "image/png";
          lines.push(await this.saveImageBytes(await res.arrayBuffer(), type));
        } else {
          lines.push(`![](${src})`);
        }
      }
    } catch (err) {
      console.error("Better Tables: could not save the image", err);
      new Notice("Better Tables: failed to save the image.");
      return null;
    }
    return lines;
  }

  appendToCell(r, c, text) {
    const cell = this.cells[r] && this.cells[r][c];
    this.cells[r][c] = cell ? `${cell}\n${text}` : text;
    this.dirty = true;
    this.save();
  }

  /** src attributes of images in pasted HTML that we can reference directly
   *  (remote URLs) or decode into a file (data: URLs). */
  imageSrcsFromHtml(html) {
    if (!html) return [];
    try {
      const doc = this.doc;
      const view = (doc && doc.defaultView) || window;
      const Parser = view.DOMParser || (typeof DOMParser !== "undefined" ? DOMParser : null);
      if (!Parser) return [];
      const parsed = new Parser().parseFromString(html, "text/html");
      return Array.from(parsed.querySelectorAll("img"))
        .map((img) => (img.getAttribute("src") || "").trim())
        .filter((src) => /^(https?:\/\/|data:image\/|blob:)/i.test(src));
    } catch {
      return [];
    }
  }

  async savePastedImage(file) {
    const bytes = await file.arrayBuffer();
    return this.saveImageBytes(bytes, file.type || "image/png");
  }

  async saveImageBytes(bytes, type) {
    const app = this.plugin.app;
    const name = `Pasted image ${attachmentStamp()}.${extForImage(type)}`;
    const path = await this.attachmentPath(name);
    const slash = path.lastIndexOf("/");
    if (slash > 0) await this.ensureFolder(path.slice(0, slash));
    const file = await app.vault.createBinary(path, bytes);
    return this.imageEmbedMarkdown(file);
  }

  /** Markdown for an image file, in the same shape Obsidian itself pastes:
   *  `![](./Attachments/photo.webp)` for Markdown links, or a wikilink embed —
   *  but always without an alias/alt, which caption features would render. */
  imageEmbedMarkdown(file) {
    const app = this.plugin.app;
    const fm = app.fileManager;
    let link = "";
    if (fm && typeof fm.generateMarkdownLink === "function") {
      try {
        link = fm.generateMarkdownLink(file, this.ctx.sourcePath || "");
      } catch {
        link = "";
      }
    }
    // generateMarkdownLink already applies the vault's link settings (wikilinks
    // vs Markdown, relative vs vault-absolute path, space encoding), so reuse
    // its path and drop only the display text it appends.
    if (link) {
      const wiki = /^\[\[([\s\S]*)\]\]$/.exec(link);
      if (wiki) return `![[${wiki[1].split("|")[0]}]]`;
      const md = /^\[[^\]]*\]\(([\s\S]*)\)$/.exec(link);
      if (md) return `![](${md[1]})`;
    }
    // Older clients without generateMarkdownLink.
    const path = file.path || file.name || "";
    if (typeof app.vault.getConfig === "function" && app.vault.getConfig("useMarkdownLinks")) {
      const src = path
        .split("/")
        .map((seg) =>
          encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/!/g, "%21")
        )
        .join("/");
      return `![](${src})`;
    }
    return `![[${path}]]`;
  }

  /** Rendered content that owns its own pointer events and menus: images,
   *  embeds, links (menu only) and controls injected by other plugins. Our cell
   *  handlers step aside so those keep working. */
  cellContentIsInteractive(target, td, includeLinks) {
    if (!td || !target || target === td || !td.contains(target) || !target.closest) return false;
    const selector =
      "img, .internal-embed, .image-embed, canvas, video, audio, iframe, " +
      "button, input, select, textarea, .clickable-icon, [role='button'], [contenteditable='true']" +
      (includeLinks ? ", a" : "");
    const el = target.closest(selector);
    return !!el && el !== td;
  }

  /** Where to put an attachment: Obsidian's own resolver when available, so the
   *  user's attachment folder settings (vault root, note folder, subfolder)
   *  are respected, with a manual fallback for older clients. */
  async attachmentPath(name) {
    const app = this.plugin.app;
    const fm = app.fileManager;
    const sourcePath = this.ctx.sourcePath || "";
    if (fm && typeof fm.getAvailablePathForAttachment === "function") {
      return await fm.getAvailablePathForAttachment(name, sourcePath);
    }
    if (fm && typeof fm.getAvailablePathForAttachments === "function") {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot + 1) : "";
      const note = app.vault.getAbstractFileByPath(sourcePath) || undefined;
      return await fm.getAvailablePathForAttachments(base, ext, note);
    }
    const configured =
      typeof app.vault.getConfig === "function" ? app.vault.getConfig("attachmentFolderPath") : "";
    const dir = String(configured || "")
      .replace(/^\.\//, "")
      .replace(/^\/+|\/+$/g, "");
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? `${name.slice(dot)}` : "";
    let candidate = name;
    let n = 1;
    const full = (file) => (dir ? `${dir}/${file}` : file);
    while (app.vault.getAbstractFileByPath(full(candidate))) {
      candidate = `${base} ${n}${ext}`;
      n++;
    }
    return full(candidate);
  }

  /** Create the attachment subfolder if the settings point at one that doesn't
   *  exist yet. Best effort: an existing folder (or a race) is fine. */
  async ensureFolder(path) {
    const app = this.plugin.app;
    if (!path || app.vault.getAbstractFileByPath(path)) return;
    try {
      await app.vault.createFolder(path);
    } catch (err) {
      // Already created (e.g. by a parallel paste) — nothing to do.
    }
  }

  /** Insert plain text at the caret without execCommand, so it works with the
   *  contentEditable cell and leaves the caret after the inserted text. */
  insertTextAtCaret(td, text, savedRange) {
    td.focus();
    const sel = window.getSelection();
    if (!sel) return;
    if (savedRange && td.contains(savedRange.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    if (!sel.rangeCount || !td.contains(sel.getRangeAt(0).startContainer)) {
      const atEnd = this.doc.createRange();
      atEnd.selectNodeContents(td);
      atEnd.collapse(false);
      sel.removeAllRanges();
      sel.addRange(atEnd);
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = this.doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    window.requestAnimationFrame(() => this.layout());
  }

  // --- cell editing ---
  async renderCellMarkdown(td, text) {
    td._btRawText = text;
    td._btRenderVersion = (td._btRenderVersion || 0) + 1;
    const version = td._btRenderVersion;
    td.empty();
    if (!text) return;

    const target = td.createDiv({ cls: "cp-cell-markdown" });
    try {
      const owner = this.mdComponent || this.plugin;
      if (MarkdownRenderer.render) {
        await MarkdownRenderer.render(this.plugin.app, text, target, this.ctx.sourcePath || "", owner);
      } else {
        await MarkdownRenderer.renderMarkdown(text, target, this.ctx.sourcePath || "", owner);
      }
      if (td._btRenderVersion !== version || this.editingCell === td) return;
      this.layout();
    } catch (err) {
      console.error("Better Tables: cell markdown render failed", err);
      if (td._btRenderVersion === version && this.editingCell !== td) td.setText(text);
    }
  }

  /** Wire up a freshly created <td>: its text, header style, and the
   *  click-to-edit / re-layout-on-input listeners. Shared by render() and
   *  appendRowAndEdit() so both build identical cells. */
  bindCell(td, r, c, text) {
    this.renderCellMarkdown(td, text);
    if (r === 0) td.addClass("cp-table-header");
    // Reading view: display-only cell, no editing/selection/align listeners.
    if (this.readOnly) return;
    // Use mousedown (not pointerdown): CodeMirror manages focus on mousedown,
    // so this is the event we must intercept to stop the editor from yanking
    // focus back out of the cell — which was eating the first Tab/Enter.
    td.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if ((e.metaKey || e.ctrlKey) && e.target && e.target.closest && e.target.closest("a")) return;
      // Already editing this cell: leave the event alone so native caret
      // placement and drag-to-select-text work.
      if (this.editingCell === td) return;
      // Images, embeds and controls that another plugin (or Obsidian) put in
      // the cell keep their own clicks — otherwise a toolbar button would be
      // swallowed and turned into a cell selection.
      if (this.cellContentIsInteractive(e.target, td)) {
        // Drop our selection so our document-level key handler can't steal
        // keystrokes meant for that control.
        this.clearCellSelection();
        this.clearLineSelection();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // Editing a DIFFERENT cell: commit that edit first, then treat this press
      // normally (click → select the cell, drag → select a range).
      if (this.editingCell) this.finishEditing();
      // Shift+click with an existing selection: extend it from its anchor to
      // this cell (spreadsheet behavior) instead of starting over.
      if (e.shiftKey && this.cellSel) {
        this.updateCellSelection(r, c);
        return;
      }
      // A press here is ambiguous: a click selects the cell, a drag selects a
      // range of cells. beginCellPointer resolves it on move/up.
      this.beginCellPointer(td, r, c, e);
    });
    td.addEventListener("input", () => {
      this.refreshInternalLinkSuggest(td);
      window.requestAnimationFrame(() => this.layout());
    });
    // Pasting an image: the browser would drop an <img> into the contentEditable
    // cell, and the cell only stores text — so the picture vanished on commit.
    // Save it to the vault's attachment folder and insert the embed instead.
    // Capture phase + stopPropagation so Obsidian's own paste handler can't
    // also attach the image to the note at the editor cursor.
    td.addEventListener(
      "paste",
      (e) => {
        if (this.editingCell !== td) return;
        this.handleCellPaste(td, r, c, e);
      },
      true
    );
    // Dropping an image file has the same problem, and Obsidian's own drop
    // handler would attach it to the note instead of the cell.
    td.addEventListener(
      "dragover",
      (e) => {
        if (!e.dataTransfer) return;
        const types = Array.from(e.dataTransfer.types || []);
        if (types.includes("Files") || types.some((t) => /image\//i.test(t))) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      },
      true
    );
    td.addEventListener(
      "drop",
      (e) => {
        if (!e.dataTransfer) return;
        const types = Array.from(e.dataTransfer.types || []);
        const hasImage = types.includes("Files") || types.some((t) => /image\//i.test(t));
        if (!hasImage) return;
        this.handleCellDrop(td, r, c, e);
      },
      true
    );
    // Right-click a cell → merge/split plus the column's text alignment
    // (markdown only supports per-column alignment, so that applies to the
    // whole column). Rendered content — images, embeds, links, plugin controls —
    // keeps its native menu, so other plugins can offer their own actions.
    td.addEventListener("contextmenu", (e) => {
      if (this.editingCell) {
        // A cell is being edited → Obsidian shows its native editor menu. Flag
        // the column so the editor-menu hook can append Align to that menu
        // (rather than us suppressing the native Cut/Copy/Paste).
        this.plugin.pendingAlign = { widget: this, col: c, at: Date.now() };
        return;
      }
      if (this.cellContentIsInteractive(e.target, td, true)) {
        // Native menu for the image/embed/plugin control; drop our cell
        // selection so its keyboard shortcuts are not intercepted.
        this.clearCellSelection();
        this.clearLineSelection();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      // If this cell is part of a drag selection, offer block actions first.
      let cols = [c];
      if (this.cellInSelection(r, c)) {
        menu.addItem((i) => i.setTitle("Copy").setIcon("copy").onClick(() => this.copyCellSelection()));
        menu.addItem((i) => i.setTitle("Clear contents").setIcon("eraser").onClick(() => this.clearSelectedCells()));
        const { rA, rB, cA, cB } = this.selRect();
        if (rA !== rB || cA !== cB) {
          menu.addSeparator();
          menu.addItem((i) =>
            i.setTitle("Merge cells").setIcon("combine").onClick(() => this.mergeSelection())
          );
        }
        menu.addSeparator();
        // Align every column the selection spans, not just the one clicked.
        cols = [];
        for (let ci = cA; ci <= cB; ci++) cols.push(ci);
      }
      // A merged cell offers to split back into its grid cells.
      const merged = this.mergeFor(r, c);
      if (merged && (merged.rs > 1 || merged.cs > 1)) {
        if (!this.cellInSelection(r, c)) menu.addSeparator();
        menu.addItem((i) =>
          i
            .setTitle(merged.rs > 1 && merged.cs > 1 ? "Split into cells" : "Unmerge cells")
            .setIcon("split")
            .onClick(() => this.unmergeAt(merged.r, merged.c))
        );
        menu.addSeparator();
      }
      this.addAlignItems(menu, cols);
      menu.showAtMouseEvent(e);
    });
  }

  /** Append the three column-alignment items to a menu. Shared by our own
   *  right-click menu and the injected entries in Obsidian's editor menu. */
  addAlignItems(menu, cols) {
    const list = Array.isArray(cols) ? cols : [cols];
    // Show a checkmark only when every targeted column shares that alignment.
    const allAre = (val) => list.every((c) => (this.colAlign[c] || "left") === val);
    [
      ["Align left", "align-left", "left"],
      ["Align center", "align-center", "center"],
      ["Align right", "align-right", "right"]
    ].forEach(([title, icon, val]) => {
      menu.addItem((i) =>
        i
          .setTitle(title)
          .setIcon(icon)
          .setChecked(allAre(val))
          .onClick(() => this.setColAlign(list, val))
      );
    });
  }

  /** Set a column's alignment and persist. "left" is the markdown default, so
   *  it's stored as null (a plain --- separator). */
  setColAlign(cols, val) {
    this.flushEdit();
    const list = Array.isArray(cols) ? cols : [cols];
    list.forEach((c) => {
      this.colAlign[c] = val === "left" ? null : val;
    });
    this.applyAlign();
    this.dirty = true;
    this.save();
  }

  // --- cell range selection (drag across cells) ---
  /** Resolve a press on a cell into either a click (edit) or a drag (select a
   *  rectangular block of cells). */
  beginCellPointer(startTd, r0, c0, downEvt) {
    // Spreadsheet model: a click SELECTS the cell; clicking again on the cell
    // that's already the sole selection is what enters edit mode. Capture that
    // "was already selected" state before clearing, so the mouseup can decide.
    const wasSelected =
      this.cellSel &&
      this.cellSel.r0 === r0 &&
      this.cellSel.c0 === c0 &&
      this.cellSel.r1 === r0 &&
      this.cellSel.c1 === c0;
    this.clearCellSelection();
    const startX = downEvt.clientX;
    const startY = downEvt.clientY;
    let dragging = false;
    const onMove = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        dragging = true;
        this.finishEditing();
        this.clearLineSelection();
        this.beginCellSelection(r0, c0);
      }
      const cell = this.cellAtPoint(ev.clientX, ev.clientY);
      if (cell) this.updateCellSelection(cell.r, cell.c);
    };
    const onUp = (ev) => {
      this.doc.removeEventListener("mousemove", onMove, true);
      this.doc.removeEventListener("mouseup", onUp, true);
      if (dragging) return; // selection stays
      // In two-step mode (default), the first click only selects; editing needs
      // a second click on the already-selected cell. In quick-edit mode a single
      // click edits straight away.
      if (!this.plugin.settings.quickEdit && !wasSelected) {
        this.clearLineSelection();
        this.beginCellSelection(r0, c0);
        return;
      }
      // Edit the cell, caret at the click point.
      this.editCell(startTd, r0, c0, false);
      const range = this.doc.caretRangeFromPoint && this.doc.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (range) {
        const sel = window.getSelection();
        sel && sel.removeAllRanges();
        sel && sel.addRange(range);
      }
    };
    this.doc.addEventListener("mousemove", onMove, true);
    this.doc.addEventListener("mouseup", onUp, true);
  }

  /** Hit-test a viewport point to the cell under it, or null. A merged cell
   *  reports its origin position. */
  cellAtPoint(x, y) {
    const t = this.tableEl;
    if (!t) return null;
    for (const tr of Array.from(t.rows)) {
      for (const td of Array.from(tr.cells)) {
        const rect = td.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return { r: td._btR, c: td._btC };
        }
      }
    }
    return null;
  }

  beginCellSelection(r0, c0) {
    this.cellSel = { r0, c0, r1: r0, c1: c0 };
    this.highlightCellSelection();
    this.cellSelOutside = (ev) => {
      if (!this.rootEl || !this.rootEl.contains(ev.target)) this.clearCellSelection();
    };
    this.doc.addEventListener("pointerdown", this.cellSelOutside, true);
    this.cellSelKey = (ev) => {
      if (this.isEditing() || !this.cellSel) return;
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        ev.stopPropagation();
        this.clearSelectedCells();
      } else if (ev.key === "Escape") {
        this.clearCellSelection();
      } else if ((ev.metaKey || ev.ctrlKey) && (ev.key === "c" || ev.key === "C")) {
        ev.preventDefault();
        this.copyCellSelection();
      } else if (ev.altKey && (ev.key === "m" || ev.key === "M")) {
        // Alt+M merges the selection; Alt+Shift+M splits the anchor's cell.
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.shiftKey) {
          const { r0, c0 } = this.cellSel;
          const m = this.mergeFor(r0, c0);
          if (m) this.unmergeAt(m.r, m.c);
        } else {
          this.mergeSelection();
        }
      } else if (ev.key === "Enter" || ev.key === "F2") {
        // Edit the selection's anchor cell, caret at the end.
        ev.preventDefault();
        ev.stopPropagation();
        const { r0, c0 } = this.cellSel;
        const o = this.originOf(r0, c0);
        const td = this.tdAt(o.r, o.c);
        if (td) this.editCell(td, o.r, o.c, true);
      } else if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        // Type-to-edit: typing on a selected cell starts editing and REPLACES
        // its content (spreadsheet behavior). Empty the cell and let the
        // browser's default insertion type the character — that way the caret
        // naturally lands after it (manually placing the caret raced with
        // focus and left it before the first letter).
        ev.stopPropagation();
        const { r0, c0 } = this.cellSel;
        const o = this.originOf(r0, c0);
        const td = this.tdAt(o.r, o.c);
        if (!td) return;
        this.editCell(td, o.r, o.c, true);
        td.setText("");
      }
    };
    this.doc.addEventListener("keydown", this.cellSelKey, true);
  }

  updateCellSelection(r1, c1) {
    if (!this.cellSel) return;
    if (this.cellSel.r1 === r1 && this.cellSel.c1 === c1) return;
    this.cellSel.r1 = r1;
    this.cellSel.c1 = c1;
    this.highlightCellSelection();
  }

  /** Normalized {rA,rB,cA,cB} bounds of the current cell selection. */
  selRect() {
    const { r0, c0, r1, c1 } = this.cellSel;
    return {
      rA: Math.min(r0, r1),
      rB: Math.max(r0, r1),
      cA: Math.min(c0, c1),
      cB: Math.max(c0, c1)
    };
  }

  highlightCellSelection() {
    const t = this.tableEl;
    if (!t) return;
    t.querySelectorAll("td.cp-cell-selected").forEach((td) => td.removeClass("cp-cell-selected"));
    if (!this.cellSel) {
      this.positionCellSelBox();
      return;
    }
    const { rA, rB, cA, cB } = this.selRect();
    const hit = new Set();
    for (let ri = rA; ri <= rB; ri++) {
      for (let ci = cA; ci <= cB; ci++) {
        // A merged cell paints several grid positions; highlight it once.
        const cell = this.tdAt(ri, ci);
        if (cell && !hit.has(cell)) {
          hit.add(cell);
          cell.addClass("cp-cell-selected");
        }
      }
    }
    this.positionCellSelBox();
  }

  /** Draw the selection outline as one overlay rectangle above the grid, so the
   *  cells' own borders can't paint over it (an inset box-shadow would sit under
   *  those borders). Sized from the grid geometry so merged cells — which have
   *  no DOM cell of their own — are framed correctly too. */
  positionCellSelBox() {
    if (!this.cellSel) {
      if (this.cellSelBox) this.cellSelBox.style.display = "none";
      return;
    }
    const t = this.tableEl;
    if (!t) return;
    const rowA = t.rows[this.selRect().rA];
    const rowB = t.rows[this.selRect().rB];
    if (!rowA || !rowB) return;
    if (!this.cellSelBox) {
      this.cellSelBox = this.rootEl.createDiv({ cls: "cp-cell-selbox" });
    }
    const { rA, rB, cA, cB } = this.selRect();
    const geo = this.colBounds();
    if (geo.widths[cA] == null || geo.widths[cB] == null) {
      this.cellSelBox.style.display = "none";
      return;
    }
    const left = geo.lefts[cA];
    const top = rowA.offsetTop;
    const width = geo.lefts[cB] + geo.widths[cB] - left;
    const height = rowB.offsetTop + rowB.offsetHeight - top;
    this.cellSelBox.style.display = "block";
    this.cellSelBox.style.left = `${left}px`;
    this.cellSelBox.style.top = `${top}px`;
    this.cellSelBox.style.width = `${width}px`;
    this.cellSelBox.style.height = `${height}px`;
  }

  clearCellSelection() {
    if (this.tableEl) {
      this.tableEl.querySelectorAll("td.cp-cell-selected").forEach((td) => td.removeClass("cp-cell-selected"));
    }
    this.cellSel = null;
    if (this.cellSelBox) this.cellSelBox.style.display = "none";
    if (this.cellSelOutside) {
      this.doc.removeEventListener("pointerdown", this.cellSelOutside, true);
      this.cellSelOutside = null;
    }
    if (this.cellSelKey) {
      this.doc.removeEventListener("keydown", this.cellSelKey, true);
      this.cellSelKey = null;
    }
  }

  /** Empty every cell in the selection, then persist. */
  clearSelectedCells() {
    if (!this.cellSel) return;
    const { rA, rB, cA, cB } = this.selRect();
    let changed = false;
    for (let ri = rA; ri <= rB; ri++) {
      for (let ci = cA; ci <= cB; ci++) {
        if (this.cells[ri][ci] !== "") {
          this.cells[ri][ci] = "";
          changed = true;
        }
      }
    }
    // Clear first so this widget's doc listeners are removed before save()
    // re-renders the block into a fresh widget.
    this.clearCellSelection();
    if (changed) {
      this.dirty = true;
      this.save();
    }
  }

  /** Copy the selection to the clipboard as tab-separated rows. */
  copyCellSelection() {
    if (!this.cellSel) return;
    const { rA, rB, cA, cB } = this.selRect();
    const lines = [];
    for (let ri = rA; ri <= rB; ri++) {
      const row = [];
      for (let ci = cA; ci <= cB; ci++) row.push(this.cells[ri][ci]);
      lines.push(row.join("\t"));
    }
    navigator.clipboard.writeText(lines.join("\n"));
    new Notice("Better Tables: cells copied.");
  }

  /** True if (r,c) falls inside the current cell selection. */
  cellInSelection(r, c) {
    if (!this.cellSel) return false;
    const { rA, rB, cA, cB } = this.selRect();
    return r >= rA && r <= rB && c >= cA && c <= cB;
  }

  selectionOffsets(td) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!td.contains(range.startContainer) || !td.contains(range.endContainer)) return null;
    const pre = range.cloneRange();
    pre.selectNodeContents(td);
    pre.setEnd(range.startContainer, range.startOffset);
    return { start: pre.toString().length, end: pre.toString().length + range.toString().length };
  }

  setCellTextAndCaret(td, text, caret) {
    td.setText(text);
    td.focus();
    const node = td.firstChild || td.appendChild(this.doc.createTextNode(""));
    const pos = Math.max(0, Math.min(caret, node.nodeValue.length));
    const range = this.doc.createRange();
    range.setStart(node, pos);
    range.collapse(true);
    const sel = window.getSelection();
    sel && sel.removeAllRanges();
    sel && sel.addRange(range);
    window.requestAnimationFrame(() => this.layout());
  }

  nativeMarkdownLink(file) {
    const sourcePath = this.ctx.sourcePath || "";
    const fm = this.plugin.app.fileManager;
    if (fm && fm.generateMarkdownLink) return fm.generateMarkdownLink(file, sourcePath);
    return `[[${file.basename}]]`;
  }

  linkTriggerInfo(td) {
    const pos = this.selectionOffsets(td);
    if (!pos || pos.start !== pos.end) return null;
    const text = this.cellText(td);
    const before = text.slice(0, pos.start);
    const start = before.lastIndexOf("[[");
    if (start === -1) return null;
    const query = before.slice(start + 2);
    if (query.includes("]]") || query.includes("\n")) return null;
    if (/[#^|]/.test(query)) return null;
    return { start, end: pos.end, query, text };
  }

  linkSuggestFiles(query) {
    const q = query.trim().toLowerCase();
    const files = this.plugin.app.vault.getFiles ? this.plugin.app.vault.getFiles() : this.plugin.app.vault.getMarkdownFiles();
    const scored = [];
    for (const file of files) {
      const title = file.basename || file.name || file.path;
      const path = file.path || title;
      const hay = `${title}\n${path}`.toLowerCase();
      let score = 0;
      if (!q) score = 1;
      else if (title.toLowerCase() === q) score = 100;
      else if (title.toLowerCase().startsWith(q)) score = 80;
      else if (path.toLowerCase().startsWith(q)) score = 70;
      else if (hay.includes(q)) score = 50;
      else {
        let at = 0;
        for (const ch of q) {
          at = hay.indexOf(ch, at);
          if (at === -1) break;
          at++;
        }
        if (at !== -1) score = 20;
      }
      if (score) scored.push({ file, score, title, path });
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored.slice(0, MAX_LINK_SUGGESTIONS).map((x) => x.file);
  }

  positionLinkSuggest() {
    if (!this.linkSuggestEl || !this.linkSuggestTd) return;
    const rect = this.linkSuggestTd.getBoundingClientRect();
    const vw = this.doc.defaultView ? this.doc.defaultView.innerWidth : window.innerWidth;
    const vh = this.doc.defaultView ? this.doc.defaultView.innerHeight : window.innerHeight;
    const width = Math.min(Math.max(rect.width, 320), 520, vw - 24);
    const left = Math.max(12, Math.min(rect.left, vw - width - 12));
    const below = rect.bottom + 4;
    const maxHeight = Math.max(160, Math.min(360, vh - below - 12));
    this.linkSuggestEl.style.left = `${left}px`;
    this.linkSuggestEl.style.top = `${below}px`;
    this.linkSuggestEl.style.width = `${width}px`;
    this.linkSuggestEl.style.maxHeight = `${maxHeight}px`;
  }

  renderLinkSuggest(td, info) {
    this.linkSuggestTd = td;
    if (!this.linkSuggestInfo || this.linkSuggestInfo.query !== info.query) this.linkSuggestIndex = 0;
    this.linkSuggestInfo = info;
    this.linkSuggestItems = this.linkSuggestFiles(info.query);
    this.linkSuggestIndex = Math.min(this.linkSuggestIndex || 0, Math.max(0, this.linkSuggestItems.length - 1));

    if (!this.linkSuggestEl) {
      const el = (this.linkSuggestEl = this.doc.body.createDiv({ cls: "suggestion-container better-tables-link-suggest" }));
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      this.linkSuggestOutside = (ev) => {
        if (ev.target === td || td.contains(ev.target) || el.contains(ev.target)) return;
        this.closeInternalLinkSuggest();
      };
      this.doc.addEventListener("mousedown", this.linkSuggestOutside, true);
    }

    const el = this.linkSuggestEl;
    el.empty();
    this.linkSuggestItems.forEach((file, i) => {
      const item = el.createDiv({ cls: `suggestion-item${i === this.linkSuggestIndex ? " is-selected" : ""}` });
      item.createDiv({ cls: "suggestion-title", text: file.basename || file.name || file.path });
      const folder = (file.parent && file.parent.path && file.parent.path !== "/" ? `${file.parent.path}/` : "") || "";
      item.createDiv({ cls: "suggestion-note", text: folder });
      item.addEventListener("mouseenter", () => {
        this.linkSuggestIndex = i;
        this.renderLinkSuggest(td, this.linkSuggestInfo);
      });
      item.addEventListener("click", () => this.chooseInternalLink(file));
    });
    if (!this.linkSuggestItems.length) el.createDiv({ cls: "suggestion-item is-disabled", text: "No matches" });
    this.positionLinkSuggest();
  }

  refreshInternalLinkSuggest(td) {
    if (this.editingCell !== td) return;
    const info = this.linkTriggerInfo(td);
    if (!info) {
      this.closeInternalLinkSuggest();
      return;
    }
    this.renderLinkSuggest(td, info);
  }

  moveInternalLinkSuggest(dir) {
    if (!this.linkSuggestEl || !this.linkSuggestItems || !this.linkSuggestItems.length) return;
    this.linkSuggestIndex = (this.linkSuggestIndex + dir + this.linkSuggestItems.length) % this.linkSuggestItems.length;
    this.renderLinkSuggest(this.linkSuggestTd, this.linkSuggestInfo);
  }

  chooseInternalLink(file) {
    const td = this.linkSuggestTd;
    const info = td && this.linkTriggerInfo(td);
    if (!td || !info) return;
    const link = this.nativeMarkdownLink(file);
    const text = `${info.text.slice(0, info.start)}${link}${info.text.slice(info.end)}`;
    this.closeInternalLinkSuggest();
    this.setCellTextAndCaret(td, text, info.start + link.length);
  }

  closeInternalLinkSuggest() {
    if (this.linkSuggestOutside) {
      this.doc.removeEventListener("mousedown", this.linkSuggestOutside, true);
      this.linkSuggestOutside = null;
    }
    if (this.linkSuggestEl) {
      this.linkSuggestEl.detach();
      this.linkSuggestEl = null;
    }
    this.linkSuggestTd = null;
    this.linkSuggestInfo = null;
    this.linkSuggestItems = [];
    this.linkSuggestIndex = 0;
  }

  editCell(td, r, c, fromKeyboard) {
    if (this.editingCell === td) return;
    this.clearCellSelection();
    this.finishEditing();
    this.editingCell = td;
    this.editingPos = { r, c };
    td._btRenderVersion = (td._btRenderVersion || 0) + 1;
    td.setText(this.cells[r][c] || "");
    td.contentEditable = "true";
    td.addClass("is-editing-cell");
    // Always take keyboard focus so the cell captures the very first Tab/Enter.
    // Only for keyboard navigation do we drop the caret at the end; for a click
    // the caller (mousedown) places the caret at the clicked point.
    td.focus();
    if (fromKeyboard) {
      const range = this.doc.createRange();
      range.selectNodeContents(td);
      range.collapse(false);
      const sel = window.getSelection();
      sel && sel.removeAllRanges();
      sel && sel.addRange(range);
    }
    // Blur commits and saves — unless the edit was already committed (e.g. by a
    // structural action or keyboard navigation), in which case editingCell has
    // been cleared and this is a no-op so we never issue a racing save.
    const onBlur = () => {
      this.closeInternalLinkSuggest();
      if (this.editingCell === td) this.commitCell(td, r, c, true);
    };
    td.addEventListener("blur", onBlur, { once: true });
    // Bind navigation keys once per cell so repeated edits don't stack handlers
    // (which would double-fire Tab/Enter navigation).
    if (!td._btKeyBound) {
      td._btKeyBound = true;
      td.addEventListener("keydown", (e) => {
        if (this.editingCell !== td) return;
        const mod = e.metaKey || e.ctrlKey;
        if (this.linkSuggestEl) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            this.moveInternalLinkSuggest(e.key === "ArrowDown" ? 1 : -1);
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            if (this.linkSuggestItems && this.linkSuggestItems.length) {
              e.preventDefault();
              e.stopPropagation();
              this.chooseInternalLink(this.linkSuggestItems[this.linkSuggestIndex || 0]);
              return;
            }
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.closeInternalLinkSuggest();
            return;
          }
        }
        // Cmd/Ctrl+A — select all text in THIS cell (not the whole note).
        if (mod && (e.key === "a" || e.key === "A")) {
          e.preventDefault();
          e.stopPropagation();
          const range = this.doc.createRange();
          range.selectNodeContents(td);
          const sel = window.getSelection();
          sel && sel.removeAllRanges();
          sel && sel.addRange(range);
          return;
        }
        // Cmd/Ctrl+Enter or Shift+Enter — insert a line break inside the cell.
        if ((mod || e.shiftKey) && e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          this.insertLineBreak(td);
          return;
        }
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          td.blur();
        } else if (e.key === "Tab") {
          e.preventDefault();
          // "Last cell" means the bottom-right corner of the grid; a merged
          // cell may cover it, so compare against the grid, not the DOM.
          const lastCell = r === this.cells.length - 1 && (c + (this.mergeFor(r, c) ? this.mergeFor(r, c).cs : 1) - 1 === this.cells[0].length - 1);
          // Tab off the bottom-right cell grows the table and continues in the
          // new row's first cell, so you can fill a table without reaching for
          // the mouse.
          if (!e.shiftKey && lastCell) this.appendRowAndEdit(0);
          else this.editNeighbor(r, c, 0, e.shiftKey ? -1 : 1, true);
        } else if (e.key === "Enter") {
          e.preventDefault();
          // Enter on the last row grows the table and keeps editing in the new
          // row, so you can keep typing down the column.
          const origin = this.originOf(r, c);
          const endsOnLastRow = origin.r + (this.mergeFor(r, c) ? this.mergeFor(r, c).rs : 1) - 1 === this.cells.length - 1;
          if (endsOnLastRow) this.appendRowAndEdit(c);
          else this.editNeighbor(r, c, 1, 0);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
          // Arrows move the caret within the cell until it hits an edge, then
          // step to the adjacent cell.
          const edge = this.getCaretEdges(td);
          if (e.key === "ArrowLeft" && edge.atStart) {
            e.preventDefault();
            this.editNeighbor(r, c, 0, -1);
          } else if (e.key === "ArrowRight" && edge.atEnd) {
            e.preventDefault();
            this.editNeighbor(r, c, 0, 1);
          } else if (e.key === "ArrowUp" && edge.atTop) {
            e.preventDefault();
            this.editNeighbor(r, c, -1, 0);
          } else if (e.key === "ArrowDown" && edge.atBottom) {
            e.preventDefault();
            this.editNeighbor(r, c, 1, 0);
          }
        }
      });
    }
  }

  /** Move to an adjacent cell, skipping positions covered by a merged cell.
   *  Commits the current cell into the model WITHOUT saving (so no file write /
   *  re-render happens mid-navigation, which would tear down the DOM). When
   *  `eject` is set, navigating past the table edge commits + persists and
   *  exits; otherwise it's a no-op (stay in the cell). */
  editNeighbor(r, c, dr, dc, eject = false) {
    const rows = this.cells.length;
    const cols = this.cells[0].length;
    let nr = r;
    let nc = c;
    let found = false;
    for (let step = 0; step < rows * cols; step++) {
      nc += dc;
      nr += dr;
      if (nc >= cols) {
        nc = 0;
        nr++;
      } else if (nc < 0) {
        nc = cols - 1;
        nr--;
      }
      if (nr < 0 || nr >= rows) break;
      if (!this.isCovered(nr, nc)) {
        found = true;
        break;
      }
    }
    const td = found ? this.tdAt(nr, nc) : null;
    if (td) {
      this.editCell(td, nr, nc, true);
    } else if (eject) {
      // Navigated past the edge: commit and persist now.
      this.finishEditing();
      if (this.dirty) this.save();
    }
  }

  /** Append a new row to the model and DOM (no file write yet) and start editing
   *  it in the given column, so Enter on the bottom row flows into a fresh row.
   *  The save happens later when editing leaves the table, avoiding a mid-edit
   *  re-render that would drop focus. */
  appendRowAndEdit(col) {
    this.finishEditing();
    const nr = this.cells.length;
    this.cells.push(this.cells[0].map(() => ""));
    this.rowH.push(TABLE_CELL_H);
    this.dirty = true;
    const tr = this.tableEl.createEl("tr");
    const rowMap = this.cells[0].map(() => null);
    this.cells[nr].forEach((text, c) => {
      const td = tr.createEl("td");
      td._btR = nr;
      td._btC = c;
      rowMap[c] = td;
      this.bindCell(td, nr, c, text);
    });
    this.tdMap[nr] = rowMap;
    this.applySizes();
    const td = tr.cells[col];
    if (td) this.editCell(td, nr, col, true);
    this.layout();
  }

  /** Whether the caret sits at the start/end of the text and on the first/last
   *  visual line — used to decide when an arrow key should leave the cell. */
  getCaretEdges(td) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { atStart: true, atEnd: true, atTop: true, atBottom: true };
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(td);
    pre.setEnd(range.startContainer, range.startOffset);
    const atStart = range.collapsed && pre.toString().length === 0;
    const post = range.cloneRange();
    post.selectNodeContents(td);
    post.setStart(range.endContainer, range.endOffset);
    const atEnd = range.collapsed && post.toString().length === 0;
    let atTop = atStart;
    let atBottom = atEnd;
    const caretRect = range.getBoundingClientRect();
    if (caretRect && caretRect.height) {
      const cellRect = td.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(td).lineHeight) || 18;
      atTop = caretRect.top - cellRect.top < lh * 0.75;
      atBottom = cellRect.bottom - caretRect.bottom < lh * 0.75;
    }
    return { atStart, atEnd, atTop, atBottom };
  }

  /** Insert a hard line break at the caret. Uses a real <br> (a raw "\n" text
   *  node won't render a trailing newline in contentEditable); execCommand
   *  handles the trailing-<br> sentinel so the new line is visible. */
  insertLineBreak(td) {
    const ok = this.doc.execCommand && this.doc.execCommand("insertLineBreak");
    if (!ok) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br = this.doc.createElement("br");
        range.insertNode(br);
        // Sentinel <br> so the line renders when the break is at the very end.
        const tail = this.doc.createElement("br");
        br.after(tail);
        range.setStartBefore(tail);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    window.requestAnimationFrame(() => this.layout());
  }

  /** Read an edit-mode cell's DOM back to raw text, turning <br> and block
   *  boundaries into newlines (so Cmd/Shift+Enter line breaks round-trip). */
  cellText(td) {
    const parts = [];
    const walk = (node) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) {
          parts.push(n.nodeValue);
        } else if (n.nodeName === "BR") {
          parts.push("\n");
        } else if (n.nodeName === "DIV" || n.nodeName === "P") {
          if (parts.length && !parts[parts.length - 1].endsWith("\n")) parts.push("\n");
          walk(n);
        } else {
          walk(n);
        }
      });
    };
    walk(td);
    return parts.join("");
  }

  /** Pull the edited text into the model and end edit mode. Does NOT save
   *  unless doSave is set — structural actions flush then issue a single save. */
  commitCell(td, r, c, doSave) {
    // Clear editing state BEFORE disabling contentEditable. Setting
    // contentEditable=false on the focused cell fires a synchronous blur; if
    // editingCell still pointed here, the once-blur handler would re-enter
    // commitCell with doSave=true and trigger a save+re-render mid-navigation
    // (which cancelled the first Tab/Enter).
    if (this.editingCell === td) this.editingCell = null;
    this.editingPos = null;
    this.closeInternalLinkSuggest();
    td.contentEditable = "false";
    td.removeClass("is-editing-cell");
    const v = this.cellText(td).trim();
    if (v !== this.cells[r][c]) {
      this.cells[r][c] = v;
      this.dirty = true;
    }
    this.renderCellMarkdown(td, this.cells[r][c]);
    if (doSave) {
      if (this.dirty) this.save();
      else this.layout();
    } else {
      this.layout();
    }
  }

  /** Commit any in-progress cell edit into the model without saving, so a
   *  following structural change can persist everything in one write. */
  flushEdit() {
    const td = this.editingCell;
    const pos = this.editingPos;
    if (!td || !pos) return;
    this.commitCell(td, pos.r, pos.c, false);
  }

  finishEditing() {
    const td = this.editingCell;
    const pos = this.editingPos;
    if (td && pos) this.commitCell(td, pos.r, pos.c, false);
    this.editingCell = null;
    this.editingPos = null;
  }

  // --- reorder + selection ---
  bindReorder(handle, axis, index) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const table = this.tableEl;
      if (!table) return;
      const count = axis === "row" ? this.cells.length : this.cells[0].length;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      let ghost = null;
      let target = index;
      const setSrc = (on) => {
        if (axis === "row") {
          table.rows[index] && table.rows[index].toggleClass("cp-drag-src", on);
        } else {
          this.colCells(index).forEach((td) => td.toggleClass("cp-drag-src", on));
        }
      };
      const moveGhost = (ev) => {
        if (!ghost) return;
        const rr = this.rootEl.getBoundingClientRect();
        if (axis === "row") {
          ghost.style.left = "0px";
          ghost.style.top = `${ev.clientY - rr.top - ghost.offsetHeight / 2}px`;
        } else {
          ghost.style.top = "0px";
          ghost.style.left = `${ev.clientX - rr.left - ghost.offsetWidth / 2}px`;
        }
      };
      const beginDrag = (ev) => {
        dragging = true;
        this.clearLineSelection();
        handle.addClass("is-dragging");
        ghost = this.makeGhost(axis, index);
        setSrc(true);
        moveGhost(ev);
      };
      const onMove = (ev) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          beginDrag(ev);
        } else {
          moveGhost(ev);
        }
        const rect = table.getBoundingClientRect();
        const tt = axis === "row" ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
        target = Math.max(0, Math.min(count - 1, Math.floor(tt * count)));
        table.querySelectorAll("tr, td").forEach((el) => el.removeClass("cp-drop-target"));
        if (target === index) return;
        if (axis === "row") {
          table.rows[target] && table.rows[target].addClass("cp-drop-target");
        } else {
          this.colCells(target).forEach((td) => td.addClass("cp-drop-target"));
        }
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        if (!dragging) {
          if (this.selected && this.selected.axis === axis && this.selected.index === index) {
            this.clearLineSelection();
          } else {
            this.selectLine(axis, index);
          }
          return;
        }
        handle.removeClass("is-dragging");
        ghost && ghost.remove();
        setSrc(false);
        if (target !== index) {
          this.flushEdit();
          if (axis === "row") {
            const [row] = this.cells.splice(index, 1);
            this.cells.splice(target, 0, row);
            const [h] = this.rowH.splice(index, 1);
            this.rowH.splice(target, 0, h);
          } else {
            for (const row of this.cells) {
              const [cell] = row.splice(index, 1);
              row.splice(target, 0, cell);
            }
            const [w] = this.colW.splice(index, 1);
            this.colW.splice(target, 0, w);
            const [al] = this.colAlign.splice(index, 1);
            this.colAlign.splice(target, 0, al);
          }
          this.mergesAfterMove(axis, index, target);
          this.save();
        } else {
          this.render();
        }
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  selectLine(axis, index) {
    this.clearLineSelection();
    this.clearCellSelection();
    const table = this.tableEl;
    const root = this.rootEl;
    if (!table || !root) return;
    this.selected = { axis, index };
    const handles = axis === "row" ? this.rowHandles : this.colHandles;
    handles[index] && handles[index].addClass("is-selected");
    this.lineCells(axis, index).forEach((td) => td.addClass("cp-line-selected"));
    const btn = (this.deleteBtnEl = root.createDiv({
      cls: "cp-table-delete",
      attr: { "aria-label": axis === "row" ? "Delete row" : "Delete column" }
    }));
    setIcon(btn, "trash-2");
    btn.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      this.deleteLine(axis, index);
    });
    this.positionDeleteBtn();
    this.lineSelOutside = (ev) => {
      if (!root.contains(ev.target)) this.clearLineSelection();
    };
    this.doc.addEventListener("pointerdown", this.lineSelOutside, true);
    this.lineSelKey = (ev) => {
      if ((ev.key === "Delete" || ev.key === "Backspace") && !this.isEditing()) {
        ev.preventDefault();
        ev.stopPropagation();
        this.deleteLine(axis, index);
      } else if (ev.key === "Escape") {
        this.clearLineSelection();
      }
    };
    this.doc.addEventListener("keydown", this.lineSelKey, true);
  }

  /** The distinct <td>s painting a grid column (merges make DOM cells span
   *  several columns, so a column can be painted by fewer cells). */
  colCells(index) {
    const out = [];
    const seen = new Set();
    for (let r = 0; r < this.cells.length; r++) {
      const td = this.tdAt(r, index);
      if (td && !seen.has(td)) {
        seen.add(td);
        out.push(td);
      }
    }
    return out;
  }

  lineCells(axis, index) {
    const table = this.tableEl;
    if (!table) return [];
    if (axis === "row") return Array.from((table.rows[index] && table.rows[index].cells) || []);
    return this.colCells(index);
  }

  positionDeleteBtn() {
    const btn = this.deleteBtnEl;
    const sel = this.selected;
    if (!btn || !sel) return;
    const handle = (sel.axis === "row" ? this.rowHandles : this.colHandles)[sel.index];
    if (!handle) return;
    if (sel.axis === "row") {
      btn.style.top = handle.style.top;
      btn.style.left = "-34px";
    } else {
      btn.style.left = handle.style.left;
      btn.style.top = "-34px";
    }
  }

  clearLineSelection() {
    if (this.selected) {
      const { axis, index } = this.selected;
      const h = (axis === "row" ? this.rowHandles : this.colHandles)[index];
      h && h.removeClass("is-selected");
      this.lineCells(axis, index).forEach((td) => td.removeClass("cp-line-selected"));
    }
    this.selected = null;
    this.deleteBtnEl && this.deleteBtnEl.remove();
    this.deleteBtnEl = null;
    if (this.lineSelOutside) {
      this.doc.removeEventListener("pointerdown", this.lineSelOutside, true);
      this.lineSelOutside = null;
    }
    if (this.lineSelKey) {
      this.doc.removeEventListener("keydown", this.lineSelKey, true);
      this.lineSelKey = null;
    }
  }

  deleteLine(axis, index) {
    const rows = this.cells.length;
    const cols = (this.cells[0] && this.cells[0].length) || 0;
    if ((axis === "row" && rows <= 1) || (axis === "col" && cols <= 1)) {
      new Notice("Better Tables: a table needs at least one row and column.");
      return;
    }
    this.flushEdit();
    // Deleting the line a merged cell starts on shouldn't swallow its text:
    // move it to the first cell the region keeps.
    const keep = [];
    for (const m of this.merges) {
      if (axis === "row" && m.r === index && m.rs > 1) keep.push({ m, text: this.cells[m.r][m.c] });
      if (axis === "col" && m.c === index && m.cs > 1) keep.push({ m, text: this.cells[m.r][m.c] });
    }
    if (axis === "row") {
      this.cells.splice(index, 1);
      this.rowH.splice(index, 1);
    } else {
      for (const row of this.cells) row.splice(index, 1);
      this.colW.splice(index, 1);
      this.colAlign.splice(index, 1);
    }
    this.mergesAfterDelete(axis, index);
    for (const { m, text } of keep) {
      if (!this.merges.includes(m)) continue;
      const cell = this.cells[m.r] && this.cells[m.r][m.c];
      if (cell === "") this.cells[m.r][m.c] = text;
    }
    this.clearLineSelection();
    this.save();
  }

  /** Remove the entire ```table block (fences included) from the note. */
  deleteTable() {
    const el = this.el;
    const ctx = this.ctx;
    const plugin = this.plugin;
    const oldBody = this.source;
    const info = ctx.getSectionInfo(el);
    plugin.queueWrite(async () => {
      const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!file) return;
      const sec = info || ctx.getSectionInfo(el);
      try {
        await plugin.app.vault.process(file, (data) => {
          // 1) Precise path: drop the validated fenced line range, plus one
          //    trailing blank line if present, so we don't leave a gap.
          if (sec) {
            const lines = data.split("\n");
            const open = lines[sec.lineStart];
            const close = lines[sec.lineEnd];
            const fenceOpen = /^\s*(`{3,}|~{3,})\s*table\b/.test(open || "");
            const fenceClose = /^\s*(`{3,}|~{3,})\s*$/.test(close || "");
            if (fenceOpen && fenceClose) {
              let end = sec.lineEnd;
              if ((lines[end + 1] || "").trim() === "") end++;
              lines.splice(sec.lineStart, end - sec.lineStart + 1);
              return lines.join("\n");
            }
          }
          // 2) Fallback: find the body, expand to the surrounding fences, and cut
          //    the whole block — only if the body occurs exactly once.
          if (oldBody && oldBody.trim()) {
            const idx = data.indexOf(oldBody);
            if (idx !== -1 && data.indexOf(oldBody, idx + 1) === -1) {
              const before = data.slice(0, idx);
              const after = data.slice(idx + oldBody.length);
              const openMatch = before.match(/(?:^|\n)([ \t]*(?:`{3,}|~{3,})[ \t]*table\b[^\n]*\n)$/);
              const closeMatch = after.match(/^(\s*\n?[ \t]*(?:`{3,}|~{3,})[ \t]*)/);
              if (openMatch && closeMatch) {
                const start = idx - openMatch[1].length;
                let stop = idx + oldBody.length + closeMatch[1].length;
                if (data[stop] === "\n") stop++;
                return data.slice(0, start) + data.slice(stop);
              }
            }
          }
          return data; // couldn't locate the block safely — leave file untouched
        });
        new Notice("Better Tables: table deleted.");
      } catch (err) {
        console.error("Better Tables: delete failed", err);
        new Notice("Better Tables: failed to delete table.");
      }
    });
  }

  makeGhost(axis, index) {
    const t = this.tableEl;
    const g = this.rootEl.createDiv({ cls: "cp-table-ghost" });
    const gt = g.createEl("table", { cls: "cp-table" });
    if (axis === "row") {
      const src = t.rows[index];
      const tr = gt.createEl("tr");
      Array.from((src && src.cells) || []).forEach((cell) => {
        const td = tr.createEl("td");
        td.setText(cell.textContent || "");
        td.style.width = `${cell.offsetWidth}px`;
      });
      tr.style.height = `${(src && src.offsetHeight) || TABLE_CELL_H}px`;
      g.style.width = `${t.offsetWidth}px`;
    } else {
      const geo = this.colBounds();
      const colW = geo.widths[index] || TABLE_CELL_W;
      Array.from(t.rows).forEach((row, r) => {
        const tr = gt.createEl("tr");
        const td = tr.createEl("td");
        td.setText(this.cells[r][index] || "");
        td.style.width = `${colW}px`;
        tr.style.height = `${row.offsetHeight}px`;
      });
      g.style.width = `${colW}px`;
    }
    gt.style.width = "100%";
    return g;
  }

  // --- persistence: write the block back into the note file ---
  serialize() {
    const md = mdFromCells(this.cells, this.colAlign);
    let meta = `<!-- tk:cols=${this.colW.join(",")};rows=${this.rowH.join(",")}`;
    if (this.merges.length) {
      const regions = this.merges.map((m) => `${m.r},${m.c},${m.rs},${m.cs}`).join("|");
      meta += `;merge=${regions}`;
    }
    meta += " -->";
    return `${md}\n${meta}`;
  }

  save() {
    this.dirty = false;
    const oldBody = this.source;
    const body = this.serialize();
    this.source = body;
    const el = this.el;
    const ctx = this.ctx;
    const plugin = this.plugin;
    // Capture the block's line range NOW, while the element is still attached.
    // It can be null right after a block is created (Obsidian hasn't indexed it
    // yet) — in that case we fall back to locating the block by its content.
    const info = ctx.getSectionInfo(el);
    // Persist through a single serialized queue so writes can't interleave and
    // clobber each other's line ranges. Obsidian re-renders the block when the
    // file changes, so we don't render optimistically (which caused a flash).
    plugin.queueWrite(async () => {
      const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!file) return;
      const sec = info || ctx.getSectionInfo(el);
      try {
        await plugin.app.vault.process(file, (data) => {
          // 1) Precise path: replace a validated fenced line range.
          if (sec) {
            const lines = data.split("\n");
            const open = lines[sec.lineStart];
            const close = lines[sec.lineEnd];
            const fenceOpen = /^\s*(`{3,}|~{3,})\s*table\b/.test(open || "");
            const fenceClose = /^\s*(`{3,}|~{3,})\s*$/.test(close || "");
            if (fenceOpen && fenceClose) {
              const newLines = [open, ...body.split("\n"), close];
              lines.splice(sec.lineStart, sec.lineEnd - sec.lineStart + 1, ...newLines);
              return lines.join("\n");
            }
          }
          // 2) Fallback: replace the previous block body by content, but only
          //    if it occurs exactly once (otherwise we can't be sure which).
          if (oldBody && oldBody.trim()) {
            const idx = data.indexOf(oldBody);
            if (idx !== -1 && data.indexOf(oldBody, idx + 1) === -1) {
              return data.slice(0, idx) + body + data.slice(idx + oldBody.length);
            }
          }
          return data; // couldn't locate the block safely — leave file untouched
        });
      } catch (err) {
        console.error("Better Tables: save failed", err);
        new Notice("Better Tables: failed to save table.");
      }
    });
  }
}

module.exports = class BetterTablesPlugin extends Plugin {
  async onload() {
    // Serializes all table writes so concurrent saves can never interleave.
    this._writeChain = Promise.resolve();

    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new BetterTablesSettingTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor("table", (source, el, ctx) => {
      const widget = new TableWidget(this, source, el, ctx);
      // Tie the widget's lifetime to the block: when Obsidian unloads this
      // section (re-render, pane close, plugin unload) the child unloads and we
      // release the ResizeObserver, link-suggest listeners, and markdown host.
      const child = new MarkdownRenderChild(el);
      child.register(() => widget.destroy());
      ctx.addChild(child);
      widget.render();
    });

    // When a table cell is being edited, Obsidian shows its native editor menu.
    // The cell's contextmenu handler flags which column was clicked; here we
    // append our Align items so they live alongside Cut/Copy/Paste.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        const p = this.pendingAlign;
        this.pendingAlign = null;
        if (!p || Date.now() - p.at > 1000) return;
        menu.addSeparator();
        p.widget.addAlignItems(menu, p.col);
      })
    );

    this.addCommand({
      id: "insert-table",
      name: "Insert table",
      editorCallback: (editor) => {
        const block = ["```table", "|     |     |", "| --- | --- |", "|     |     |", "```", ""].join("\n");
        editor.replaceSelection(block);
      }
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Run write tasks one at a time, in order. */
  queueWrite(task) {
    this._writeChain = this._writeChain.then(task, task);
    return this._writeChain;
  }
};

class BetterTablesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Quick text edit")
      .setDesc(
        "On: a single click on a cell edits its text immediately. " +
          "Off: the first click selects the cell and a second click (or Enter) starts editing."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.quickEdit).onChange(async (value) => {
          this.plugin.settings.quickEdit = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

/* nosourcemap */
/* nosourcemap */
