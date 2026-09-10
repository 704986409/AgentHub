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
