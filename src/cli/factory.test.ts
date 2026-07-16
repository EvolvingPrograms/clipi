import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineApi } from "../api/define"
import { get } from "../api/helpers"
import { defineCommand } from "./command"
import { createCli } from "./factory"

// Same stdout/stderr/exit capture pattern as emit.test.ts.
let stdout: string[]
let stderr: string[]
let exitCode: number | undefined
let realStdoutWrite: typeof process.stdout.write
let realStderrWrite: typeof process.stderr.write
let realExit: typeof process.exit

beforeEach(() => {
  stdout = []
  stderr = []
  exitCode = undefined
  realStdoutWrite = process.stdout.write.bind(process.stdout)
  realStderrWrite = process.stderr.write.bind(process.stderr)
  realExit = process.exit.bind(process)
  process.stdout.write = ((data: string | Uint8Array) => {
    stdout.push(typeof data === "string" ? data : data.toString())
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((data: string | Uint8Array) => {
    stderr.push(typeof data === "string" ? data : data.toString())
    return true
  }) as typeof process.stderr.write
  process.exit = ((code?: number) => {
    exitCode = code
    throw new Error(`__exit_${code ?? 0}__`)
  }) as typeof process.exit
})

afterEach(() => {
  process.stdout.write = realStdoutWrite
  process.stderr.write = realStderrWrite
  process.exit = realExit
})

async function runCli(cli: ReturnType<typeof createCli>, argv: string[]): Promise<void> {
  // First two argv entries are simulated process.argv[0..1].
  await cli.program.parseAsync(["bun", "test-cli", ...argv])
}

describe("createCli — command dispatch", () => {
  test("dispatches positional + flag args correctly and JSON-emits the handler's return", async () => {
    const echo = defineCommand({
      name: "echo",
      schema: z.object({
        value: z.string(),
        upper: z.boolean().optional(),
      }),
      positional: ["value"],
      handler: ({ value, upper }) => ({
        out: upper ? value.toUpperCase() : value,
      }),
    })

    const cli = createCli({
      name: "test-cli",
      description: "test",
      commands: [echo],
    })

    // commander has a global handler-throws-on-exit issue with
    // exitOverride; since we already stub process.exit, the
    // action callback can run normally.
    cli.program.exitOverride()
    await runCli(cli, ["--json", "echo", "hello"])

    expect(stdout.join("")).toBe(`{"out":"hello"}\n`)
  })

  test("maps thrown errorClass instances to stderr + exit 1", async () => {
    class TestError extends Error { override readonly name = "TestError" }
    const fail = defineCommand({
      name: "fail",
      schema: z.object({}),
      handler: () => {
        throw new TestError("simulated")
      },
    })

    const cli = createCli({
      name: "test-cli",
      description: "test",
      commands: [fail],
      errorClass: TestError,
    })
    cli.program.exitOverride()

    try {
      await runCli(cli, ["fail"])
    } catch {
      // process.exit stub throws — swallow
    }
    expect(stderr.join("")).toContain("test-cli: simulated")
    expect(exitCode).toBe(1)
  })

  test("array flag is comma-split before the schema runs", async () => {
    const cmd = defineCommand({
      name: "list",
      schema: z.object({
        symbols: z.array(z.string()).min(1),
      }),
      handler: ({ symbols }) => symbols,
    })

    const cli = createCli({
      name: "test-cli",
      description: "test",
      commands: [cmd],
    })
    cli.program.exitOverride()

    await runCli(cli, ["--json", "list", "--symbols", "SPY,AAPL"])
    expect(stdout.join("")).toBe(`["SPY","AAPL"]\n`)
  })

  test("the program is exposed as an escape hatch", () => {
    const cli = createCli({
      name: "test-cli",
      description: "test",
      commands: [],
    })
    expect(cli.program.name()).toBe("test-cli")
  })

  test("cli.run() parses process.argv and dispatches", async () => {
    const cmd = defineCommand({
      name: "ping",
      schema: z.object({}),
      handler: () => ({ ok: true }),
    })

    const cli = createCli({
      name: "test-cli",
      description: "test",
      commands: [cmd],
    })
    cli.program.exitOverride()

    const originalArgv = process.argv
    process.argv = ["bun", "test-cli", "--json", "ping"]
    try {
      await cli.run()
    } finally {
      process.argv = originalArgv
    }

    expect(stdout.join("")).toBe(`{"ok":true}\n`)
  })

  test("--help marks --pretty as (default) when no env override is set", () => {
    const prevJson = process.env.JSON
    const prevPretty = process.env.PRETTY
    delete process.env.JSON
    delete process.env.PRETTY
    try {
      const cli = createCli({ name: "test-cli", description: "test", commands: [] })
      const help = Bun.stripANSI(cli.program.helpInformation())
      expect(help).toMatch(/--pretty\s+Emit a formatted table \(default\)\./)
      expect(help).toMatch(/--json\s+Emit raw JSON\./)
      expect(help).not.toContain("Emit raw JSON (default).")
    } finally {
      if (prevJson !== undefined) process.env.JSON = prevJson
      if (prevPretty !== undefined) process.env.PRETTY = prevPretty
    }
  })

  test("--help marks --json as (default) when JSON=1 is set in the env", () => {
    const prevJson = process.env.JSON
    const prevPretty = process.env.PRETTY
    process.env.JSON = "1"
    delete process.env.PRETTY
    try {
      const cli = createCli({ name: "test-cli", description: "test", commands: [] })
      const help = Bun.stripANSI(cli.program.helpInformation())
      expect(help).toMatch(/--json\s+Emit raw JSON \(default\)\./)
      expect(help).toMatch(/--pretty\s+Emit a formatted table\./)
      expect(help).not.toContain("Emit a formatted table (default).")
    } finally {
      if (prevJson !== undefined) process.env.JSON = prevJson
      else delete process.env.JSON
      if (prevPretty !== undefined) process.env.PRETTY = prevPretty
    }
  })

  // --- help styling + commander pass-through ---

  test("--help applies the default styling (bold titles, dim descriptions)", () => {
    const cli = createCli({ name: "test-cli", description: "test desc", commands: [] })
    const help = cli.program.helpInformation()
    // Bold around section titles like "Usage:" and "Options:".
    expect(help).toContain("\x1b[1mUsage:\x1b[0m")
    expect(help).toContain("\x1b[1mOptions:\x1b[0m")
    // Dim around description text.
    // eslint-disable-next-line no-control-regex
    expect(help).toMatch(/\x1b\[2m.*Emit raw JSON.*\x1b\[0m/)
  })

  test("caller's styleTitle wins over the default (per-property merge)", () => {
    const cli = createCli({
      name: "test-cli",
      description: "test",
      commands: [],
      commander: {
        configureHelp: { styleTitle: (s) => `<<${s}>>` },
      },
    })

    const help = cli.program.helpInformation()
    // Caller's override applies.
    expect(help).toContain("<<Usage:>>")
    expect(help).toContain("<<Options:>>")
    // Other defaults (e.g. dim descriptions) still apply because
    // the merge is per-property, not wholesale.
    // eslint-disable-next-line no-control-regex
    expect(help).toMatch(/\x1b\[2m.*Emit raw JSON.*\x1b\[0m/)
  })

  test("commander.exitOverride=true makes parse errors throw instead of exit", () => {
    const cli = createCli({
      name: "test-cli",
      description: "test",
      commands: [],
      commander: { exitOverride: true },
    })

    expect(() => cli.program.parse(["bun", "test-cli", "--bogus"])).toThrow()
    // Without exitOverride, commander would have called process.exit
    // (which our test stub catches as __exit_…). With it, a
    // CommanderError propagates instead.
  })

  test("commander.allowUnknownOption silences unknown-flag errors", () => {
    const cli = createCli({
      name: "test-cli",
      description: "test",
      commands: [],
      commander: {
        exitOverride: true,
        allowUnknownOption: true,
        allowExcessArguments: true,
      },
    })

    // Without `allowUnknownOption` + `allowExcessArguments` this
    // throws (unknown flag, then extra positional). With both, parse
    // succeeds and the program ignores the noise.
    expect(() => cli.program.parse(["bun", "test-cli", "--bogus", "v"])).not.toThrow()
  })

  test("passing `api` adds the auto-generated `api <endpoint>` subcommand tree", () => {
    // Just verify the wiring — the addApiCli atomic tests cover
    // walker + dispatch behavior in depth.
    const api = defineApi({
      name: "wired",
      baseUrl: "https://example.test",
      endpoints: {
        foo: get("/foo", z.object({ x: z.string() })),
      },
    })

    const cli = createCli({
      name: "test-cli",
      description: "test",
      commands: [],
      api,
    })

    const apiCmd = cli.program.commands.find((c) => c.name() === "api")
    expect(apiCmd).toBeDefined()
    expect(apiCmd?.commands.map((c) => c.name())).toEqual(["foo"])
  })

  // --- trailing blank line between successive invocations ---

  test("--help output ends with a trailing blank line", () => {
    const cli = createCli({ name: "test-cli", description: "test", commands: [] })
    cli.program.outputHelp()
    const out = stdout.join("")
    expect(out.length).toBeGreaterThan(0)
    // commander's help already ends with one "\n"; our writeOut hook
    // adds a second so there's a blank line before the next prompt.
    expect(out.endsWith("\n\n")).toBe(true)
    expect(out.endsWith("\n\n\n")).toBe(false)
  })

  test("bare invocation (no subcommand) shows help on stderr with a trailing blank line", async () => {
    const echo = defineCommand({
      name: "echo",
      schema: z.object({ value: z.string() }),
      positional: ["value"],
      handler: ({ value }) => ({ value }),
    })
    const cli = createCli({ name: "test-cli", description: "test", commands: [echo] })

    // Commander prints help to stderr and calls process.exit(1); our
    // stub turns that into a throw.
    let threw: unknown
    try {
      await runCli(cli, [])
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect((threw as Error).message).toBe("__exit_1__")
    const err = stderr.join("")
    expect(err.length).toBeGreaterThan(0)
    expect(err.endsWith("\n\n")).toBe(true)
    expect(err.endsWith("\n\n\n")).toBe(false)
  })
})
