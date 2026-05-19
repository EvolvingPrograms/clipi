/**
 * Dispatch tests for `prettyFormat`. We don't snapshot rendered
 * tables here — `pretty.snapshot.test.ts` pins exact rendered
 * output for the real downstream shapes. These tests assert
 * routing decisions (which shape goes through which renderer)
 * and string normalisation behaviour (URL → hyperlink, long →
 * truncated, multi-line → ⏎ marker) without comparing full
 * box-drawing strings, so they stay robust against tweaks to
 * column widths or border characters.
 */

import { describe, expect, test } from "bun:test"

import { prettyFormat } from "./pretty"

describe("prettyFormat", () => {
  test("array of flat objects → renders a single header + rows table", () => {
    const out = prettyFormat([
      { date: "2024-01-01", value: 1 },
      { date: "2024-02-01", value: 2 },
    ])

    expect(out).toMatch(/^╭.*╮\n/)
    expect(out).toMatch(/╰.*╯\n$/)
    expect(out).toContain("date")
    expect(out).toContain("2024-01-01")
    expect(out).toContain("2024-02-01")
  })

  test("array of primitives → single-column table with index", () => {
    const out = prettyFormat([0.1, -0.1, 0.05])
    expect(out).toContain("Value")
    expect(out).toContain("0.1")
    expect(out).toContain("-0.1")
  })

  test("flat object → vertical key/value table", () => {
    const out = prettyFormat({ id: "GDP", frequency: "Quarterly" })
    expect(out).toContain("Value")
    expect(out).toContain("GDP")
    expect(out).toContain("Quarterly")
  })

  test("map of flat records → single combined table with outer keys", () => {
    const out = prettyFormat({
      SPY: { price: 739.17, change: 0.42 },
      QQQ: { price: 538.10, change: 0.31 },
    })

    expect(out).toContain("SPY")
    expect(out).toContain("QQQ")
    expect(out).toContain("price")
    expect(out).toContain("change")
  })

  test("mixed object → header lines + labelled sub-tables, in insertion order", () => {
    const out = prettyFormat({
      seriesId: "GDP",
      count: 2,
      observations: [
        { date: "2016-01-01", value: 1 },
        { date: "2016-04-01", value: 2 },
      ],
    })

    expect(out).toContain("seriesId: GDP")
    expect(out).toContain("count: 2")
    expect(out).toContain("observations:")
    expect(out.indexOf("observations:")).toBeGreaterThan(out.indexOf("seriesId: GDP"))
  })

  test("insertion order preserved when containers appear before scalars", () => {
    const out = prettyFormat({
      meta: { symbol: "SPY", currency: "USD" },
      quotes: [{ date: "2024-01-02", close: 472.65 }],
    })

    expect(out.indexOf("meta:")).toBeLessThan(out.indexOf("quotes:"))
    expect(out).toContain("USD")
    expect(out).toContain("472.65")
  })

  test("single-element primitive array → inlined as `key: value`", () => {
    const out = prettyFormat({
      cik: "0000320193",
      tickers: ["AAPL"],
      filings: [{ form: "10-K" }],
    })

    expect(out).toContain("tickers: AAPL")
    expect(out).toContain("filings:")
    expect(out).toContain("10-K")
  })

  test("scalar input → printed verbatim with a trailing newline", () => {
    expect(prettyFormat("hello")).toBe("hello\n")
    expect(prettyFormat(42)).toBe("42\n")
  })

  test("array of objects with nested fields → renders as table with compact placeholders", () => {
    const out = prettyFormat([
      { id: "a", schedules: [{ cron: "0 7 * * 1" }] },
      { id: "b", schedules: [] },
    ])

    // Still a table, not util.inspect.
    expect(out).toMatch(/^╭/)
    expect(out).toContain("id")
    expect(out).toContain("schedules")
    // Nested array represented compactly.
    expect(out).toContain("[1 items]")
    expect(out).toContain("[0 items]")
  })

  test("array of non-objects/non-scalars (e.g. nested arrays) → util.inspect fallback", () => {
    const out = prettyFormat([[1, 2], [3, 4]])
    // No top-level table — these aren't tabular.
    expect(out).not.toMatch(/^╭/)
    expect(out).toContain("1")
    expect(out).toContain("4")
  })

  // --- string normalisation ---

  test("URL value → wrapped in OSC 8 hyperlink (full URL preserved)", () => {
    const url = "https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm"
    const out = prettyFormat({ form: "10-K", url })
    // OSC 8 opens with `\x1b]8;;<url>\x1b\\` and closes with `\x1b]8;;\x1b\\`.
    expect(out).toContain("\x1b]8;;" + url + "\x1b\\")
    expect(out).toContain("\x1b]8;;\x1b\\")
  })

  test("URL short enough → still hyperlinked, visible text equals URL", () => {
    const url = "https://example.com/short"
    const out = prettyFormat({ url })
    expect(out).toContain("\x1b]8;;" + url + "\x1b\\" + url + "\x1b]8;;\x1b\\")
  })

  test("multi-line string → newlines collapsed to ⏎ marker (table intact)", () => {
    const out = prettyFormat({ ticker: "AAPL", body: "Item 1.\n\nBusiness\n\nApple Inc." })
    const bodyLine = out.split("\n").find((line) => line.includes("Item 1.")) ?? ""
    expect(bodyLine).toContain("⏎")
    expect(bodyLine).toContain("Business")
  })

  test("long single-line string → truncated with `… [+N chars]` marker", () => {
    const long = "x".repeat(400)
    const out = prettyFormat({ ticker: "AAPL", description: long })
    expect(out).toMatch(/… \[\+\d+ chars\]/)
    expect(out).not.toContain(long)
  })

  test("short string with no special chars → not truncated", () => {
    const out = prettyFormat({ form: "10-K", filingDate: "2023-11-03" })
    expect(out).toContain("10-K")
    expect(out).toContain("2023-11-03")
    expect(out).not.toMatch(/\[\+\d+ chars\]/)
  })

  test("long string in array-of-objects cell is also truncated", () => {
    const out = prettyFormat([
      { ticker: "AAPL", note: "x".repeat(400) },
      { ticker: "MSFT", note: "short" },
    ])

    expect(out).toMatch(/… \[\+\d+ chars\]/)
    expect(out).toContain("short")
  })
})
