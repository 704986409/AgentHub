# AgentHub

AgentHub is a local-first agent management foundation built with Node.js,
TypeScript, and SQLite.

## V0.1.1

This release provides the core data foundation only. It intentionally contains
no agent execution logic.

### Development

```bash
npm install
npm run check
```

Available commands:

- `npm run build` - compile TypeScript into `dist/`
- `npm run typecheck` - type-check source, tests, and configuration
- `npm run lint` - run ESLint
- `npm test` - run the test suite
- `npm run check` - run build, lint, and tests

Database access is centralized in `src/database` and `src/repositories`.
Application code should use repositories instead of executing SQL directly.

## Codex App Server

V0.2.1.1 uses the locally installed Codex CLI as a long-running
`codex app-server --listen stdio://` child process. On Windows, AgentHub resolves
and executes the actual `codex.exe` directly; stdin, stdout, and stderr are all
pipes. The provider does not become ready until it receives `initialize`, then
sends the `initialized` notification.

Pass `debug: true` to `CodexProvider` or `CodexAppServerClient` to retain a
redacted in-memory protocol trace. Pass `onDiagnostic` to stream that trace to
your own logger. Protocol bindings can be regenerated for the current CLI with:

```bash
codex app-server generate-ts --out src/providers/codex/generated --experimental
codex app-server generate-json-schema --out src/providers/codex/generated-schema --experimental
```

Generated bindings are intentionally ignored from version control because the
CLI generates imports that vary by TypeScript module configuration. The runtime
uses small JSON-RPC envelope types and treats generated bindings as a local
protocol reference.

The real process integration test is enabled explicitly with
`AGENTHUB_RUN_CODEX_INTEGRATION=1`; unit and parser tests always run in the
normal `npm test` command.
