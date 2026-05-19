/**
 * Minimal ANSI-aware table renderer.
 *
 * Replaces `console.table` for the prettyPrint pipeline so we
 * can wrap long URLs in OSC 8 hyperlinks without `console.table`
 * miscounting the column width — Node/Bun's built-in renderer
 * treats every byte of the escape sequence as a visible character,
 * which inflates the cell and breaks the right border.
 *
 * We measure visible width with the modern `string-width`
 * package (handles SGR, OSC 8, emoji, fullwidth, etc.) and
 * draw the table ourselves with Unicode box-drawing chars that
 * match `console.table`'s look.
 *
 * Three shapes are supported, matching console.table's behaviour:
 *
 *   - `renderObjectTable({ a: 1, b: 2 })`     → vertical k/v
 *   - `renderArrayTable([{ x:1 }, { x:2 }])`  → header + index column
 *   - `renderMapTable({ SPY:{...}, QQQ:{...} })` → outer keys as left col
 *
 * Each takes an already-normalised value — callers are expected to
 * have truncated long strings and collapsed newlines beforehand
 * via `prettyPrint`'s helpers. The renderer itself never mutates
 * cell content, only measures and pads.
 */

import stringWidth from "string-width"

import { bold, colorize } from "./ansi"

// Rounded corners — softens the visual weight, matches how most
// modern CLIs render tables (gh, ripgrep --json | jq -C, etc.).
// Inner tees and lines stay sharp; only the four outer corners
// change.
const BOX = {
  top: { l: "╭", r: "╮", x: "┬", h: "─" },
  mid: { l: "├", r: "┤", x: "┼", h: "─" },
  bot: { l: "╰", r: "╯", x: "┴", h: "─" },
  v: "│",
}

// ----- terminal-aware sizing -------------------------------------------------
//
// We never let the rendered table exceed the terminal width. The
// natural per-column widths are computed first; if the sum + box
// overhead exceeds `process.stdout.columns`, we iteratively shrink
// the widest column by one until the table fits (with a per-column
// floor so the headers stay readable). Cells whose content exceeds
// the final column width are truncated to one ellipsis at the end.

const TERMINAL_FALLBACK = 120
const MIN_COL_WIDTH = 8

function terminalWidth(): number {
  // `process.stdout.columns` is `undefined` for non-TTYs (pipes,
  // captured stdout, snapshot subprocesses). Falling back to a
  // generous default keeps non-TTY output legible without forcing
  // every test to set a width.
  return process.stdout.columns || TERMINAL_FALLBACK
}

/** ANSI escape stripper used to measure / truncate visible content. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g

/** Truncate a cell so its visible width fits inside `width`. */
function truncate(content: string, width: number): string {
  if (stringWidth(content) <= width) return content
  // Strip ANSI for slicing; we accept losing type-color / hyperlink
  // styling on truncated cells. The unstyled prefix is still
  // readable and the table layout survives.
  const visible = content.replace(ANSI_RE, "")
  if (visible.length <= width) return content
  return visible.slice(0, Math.max(1, width - 1)).trimEnd() + "…"
}

function pad(content: string, width: number): string {
  const fitted = truncate(content, width)
  const padCount = width - stringWidth(fitted)
  if (padCount <= 0) return fitted
  return fitted + " ".repeat(padCount)
}

function rule(widths: number[], side: keyof typeof BOX): string {
  if (side === "v") return BOX.v
  const { l, r, x, h } = BOX[side]
  return l + widths.map((w) => h.repeat(w + 2)).join(x) + r
}

function row(cells: string[], widths: number[]): string {
  const padded = cells.map((c, i) => ` ${pad(c, widths[i]!)} `)
  return BOX.v + padded.join(BOX.v) + BOX.v
}

function columnWidths(headers: string[], rows: string[][]): number[] {
  return headers.map((h, i) => {
    let max = stringWidth(h)
    for (const r of rows) {
      const w = stringWidth(r[i] ?? "")
      if (w > max) max = w
    }

    return max
  })
}

/**
 * Fixed per-column overhead: `│ ` left padding + ` ` right padding.
 * Plus one trailing `│` at the end of the row.
 */
function tableOverhead(numCols: number): number {
  return numCols * 3 + 1
}

/**
 * Shrink the widest column repeatedly until the total table width
 * fits `terminalWidth()`. Floors each column at `MIN_COL_WIDTH`
 * so headers stay readable; if the table can't fit even at the
 * floor, returns the floored widths anyway and lets the terminal
 * wrap (rare in practice — would need >12 columns at 120 wide).
 */
function shrinkToFit(widths: number[]): number[] {
  const max = terminalWidth() - tableOverhead(widths.length)
  let total = widths.reduce((s, w) => s + w, 0)
  if (total <= max) return widths

  const result = widths.slice()
  while (total > max) {
    let widestIdx = -1
    let widestVal = MIN_COL_WIDTH
    for (let i = 0; i < result.length; i++) {
      if (result[i]! > widestVal) {
        widestIdx = i
        widestVal = result[i]!
      }
    }

    if (widestIdx === -1) break // every column at the floor; give up
    result[widestIdx]! -= 1
    total -= 1
  }

  return result
}

function render(headers: string[], rows: string[][]): string {
  const widths = shrinkToFit(columnWidths(headers, rows))
  // Column 0 in every renderer is the "leftmost label" — auto-index
  // in `renderArrayTable`, key in `renderObjectTable`, outer key in
  // `renderMapTable`. Bold it (it's a label, not a value). Type-color
  // every other column; never type-color the label column.
  const styledHeaders = headers.map(bold)
  const styledRows = rows.map((r) =>
    r.map((cell, ci) => (ci === 0 ? bold(cell) : colorize(cell))),
  )
  const lines = [rule(widths, "top"), row(styledHeaders, widths), rule(widths, "mid")]
  for (let i = 0; i < styledRows.length; i++) {
    lines.push(row(styledRows[i]!, widths))
  }

  lines.push(rule(widths, "bot"))
  return lines.join("\n") + "\n"
}

function cellString(v: unknown): string {
  if (v === null) return "null"
  if (v === undefined) return ""
  if (typeof v === "string") return v
  if (typeof v !== "object") return String(v)
  // Nested arrays / objects in a single cell would dump
  // `[object Object]` via `String(v)`. Render a compact preview
  // instead — `[N items]` for arrays, `{ k, k, … }` for objects —
  // so the row still scans as one line and the per-cell
  // truncation upstream can clip it if needed.
  if (Array.isArray(v)) return `[${v.length} items]`
  const keys = Object.keys(v as Record<string, unknown>)
  const preview = keys.slice(0, 3).join(", ")
  return keys.length > 3 ? `{ ${preview}, … }` : `{ ${preview} }`
}

/**
 * Render a flat object as a 2-column vertical key/value table.
 * Matches console.table({...}) on a flat object.
 */
export function renderObjectTable(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj)
  return render(
    ["", "Value"],
    entries.map(([k, v]) => [k, cellString(v)]),
  )
}

/**
 * Render an array of flat objects (or primitives) with an
 * auto-index column and a column per key. Keys come from the
 * union of all rows' keys, preserving first-seen order.
 */
export function renderArrayTable(arr: unknown[]): string {
  if (arr.length === 0) return render([""], [])

  // Primitives + non-objects fall back to single-column "Value".
  if (arr.every((item) => item === null || typeof item !== "object")) {
    return render(
      ["", "Value"],
      arr.map((v, i) => [String(i), cellString(v)]),
    )
  }

  // Union of keys, first-seen order.
  const keys: string[] = []
  for (const item of arr) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      for (const k of Object.keys(item)) {
        if (!keys.includes(k)) keys.push(k)
      }
    }
  }

  const rows = arr.map((item, i) => {
    const cells = [String(i)]
    const record = (item ?? {}) as Record<string, unknown>
    for (const k of keys) {
      cells.push(cellString(record[k]))
    }

    return cells
  })

  return render(["", ...keys], rows)
}

/**
 * Render a map-of-flat-records as a single table — outer keys
 * become the leftmost column, inner keys become headers.
 */
export function renderMapTable(map: Record<string, Record<string, unknown>>): string {
  const entries = Object.entries(map)
  if (entries.length === 0) return render([""], [])

  // Union of inner keys, first-seen order.
  const keys: string[] = []
  for (const [, record] of entries) {
    for (const k of Object.keys(record)) {
      if (!keys.includes(k)) keys.push(k)
    }
  }

  const rows = entries.map(([outer, record]) => [
    outer,
    ...keys.map((k) => cellString(record[k])),
  ])

  return render(["", ...keys], rows)
}

/**
 * Wrap visible text in an OSC 8 hyperlink escape so terminals
 * that support it (iTerm2, WezTerm, modern macOS Terminal,
 * VS Code's terminal) render `text` as a clickable link to
 * `url`. Terminals without support fall back gracefully — the
 * escape sequence is invisible and only `text` displays.
 *
 * Width measurement via `string-width` already strips this
 * sequence, so wrapped values pad correctly in the table.
 */
export function hyperlink(url: string, text: string): string {
  const OSC = "\x1b]8;;"
  const ST = "\x1b\\"
  return `${OSC}${url}${ST}${text}${OSC}${ST}`
}
