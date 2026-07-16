/**
 * `createCli({ commands, api? })` — wires a set of friendly
 * commands and (optionally) a typed API client into a commander
 * program with JSON-on-stdout emission and centralised error
 * mapping.
 */

import { Command } from "commander"
import type { HelpConfiguration } from "commander"

import { addApiCli } from "../api/cli"
import type { Cli, CommanderOptions, CreateCliOptions, StoredCommand } from "../types"
import { bold, dim, italic } from "./ansi"
import type { EmitMode } from "./emit"
import { emit, mapError, resolveDefaultMode } from "./emit"
import { collectArgs, walkSchemaToCommander } from "./walker"

/**
 * Default help-styling hooks. Section titles ("Usage:",
 * "Options:") render bold; the body text of descriptions
 * dims; the command name in "Usage:" is italic. Subcommand
 * terms only bold the leading command name — `<arg>` and
 * `[opt]` syntax inside the term stays plain so the angle/
 * bracket structure reads as syntax, not emphasis.
 *
 * Caller-provided style hooks merge per-property over these
 * defaults.
 */
const DEFAULT_HELP_STYLE: HelpConfiguration = {
  styleTitle: (s) => bold(s),
  styleCommandText: (s) => italic(s),
  // Bold the command name (everything up to the first whitespace)
  // and leave the rest — argument syntax — unstyled. Option terms
  // (`--json`, `-h, --help`) stay plain too: it's syntax, not
  // emphasis.
  styleSubcommandTerm: (s) => {
    const i = s.search(/\s/)
    return i === -1 ? bold(s) : bold(s.slice(0, i)) + s.slice(i)
  },
  styleDescriptionText: (s) => dim(s),
}

function applyCommanderOptions(
  program: Command,
  opts: CommanderOptions | undefined,
): void {
  // Always apply our default help styling. Caller's style hooks
  // override per-property — granular wins over wholesale.
  const help: HelpConfiguration = {
    ...DEFAULT_HELP_STYLE,
    ...(opts?.configureHelp ?? {}),
  }

  program.configureHelp(help)

  // Append a trailing blank line to commander-managed output so
  // successive CLI invocations don't butt up against each other in a
  // terminal. `writeOut` carries `--help`/`--version`; `writeErr`
  // carries help shown on a bare invocation (no subcommand) and
  // parse errors. Caller-provided hooks win wholesale — if they take
  // over a stream, spacing is theirs to decide.
  program.configureOutput({
    writeOut: (str) => process.stdout.write(str + "\n"),
    writeErr: (str) => process.stderr.write(str + "\n"),
    ...(opts?.configureOutput ?? {}),
  })
  if (opts?.exitOverride === true) program.exitOverride()
  else if (typeof opts?.exitOverride === "function") program.exitOverride(opts.exitOverride)
  if (opts?.helpOption !== undefined) {
    if (opts.helpOption === false) program.helpOption(false)
    else program.helpOption(...opts.helpOption)
  }

  if (opts?.showHelpAfterError !== undefined) program.showHelpAfterError(opts.showHelpAfterError)
  if (opts?.allowUnknownOption) program.allowUnknownOption()
  if (opts?.allowExcessArguments) program.allowExcessArguments()
}

export function createCli(opts: CreateCliOptions): Cli {
  const program = new Command().name(opts.name).description(opts.description)

  applyCommanderOptions(program, opts.commander)

  // Program-level output mode flags. Default is `pretty` (a
  // formatted table via `console.table`); `--json` opts out into
  // raw JSON. `JSON=1` / `PRETTY=1` in the env shift the default
  // for a shell session, and the `(default)` annotation in `--help`
  // reflects whichever mode is currently active — an explicit flag
  // always overrides at call time.
  const defaultMode = resolveDefaultMode()

  program
    .option(
      "--json",
      defaultMode === "json" ? "Emit raw JSON (default)." : "Emit raw JSON.",
    )
    .option(
      "--pretty",
      defaultMode === "pretty"
        ? "Emit a formatted table (default)."
        : "Emit a formatted table.",
    )

  for (const cmd of opts.commands) {
    registerCommand(program, cmd, opts)
  }

  if (opts.api) {
    addApiCli(program, opts.api, {
      errorName: opts.name,
      errorClass: opts.errorClass,
    })
  }

  return {
    program,
    run: async () => {
      await program.parseAsync()
    },
  }
}

function registerCommand(
  program: Command,
  cmd: StoredCommand,
  cliOpts: CreateCliOptions,
): void {
  const sub = program.command(cmd.name)
  if (cmd.description) sub.description(cmd.description)

  walkSchemaToCommander(sub, cmd.schema, { positional: cmd.positional })

  sub.action(async (...argv: unknown[]) => {
    try {
      const argsIn = collectArgs(cmd.schema, cmd.positional, argv)
      const result = await cmd.invoke(argsIn)

      // `program.opts()` reads parent-level options. Commander accepts
      // the flag in either position (`cli --json list` or `cli list --json`).
      // Explicit `--json` / `--pretty` beats env defaults inside `emit`.
      const programOpts = program.opts()
      const mode: EmitMode | undefined = programOpts.json
        ? "json"
        : programOpts.pretty
          ? "pretty"
          : undefined

      emit(result, { mode })
    } catch (err) {
      mapError(err, cliOpts.name, cliOpts.errorClass)
    }
  })
}
