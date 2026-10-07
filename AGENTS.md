# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the React/Vite client: page composition in `src/App.tsx`, reusable UI in `src/components/`, API calls in `src/api.ts`, and wallet/RPC integration in `src/solana.ts`. `worker/index.ts` handles API routes, webhooks, queues, Durable Objects, and workflows. Shared contracts and market logic belong in `shared/`; avoid duplicating them. D1 migrations live in `migrations/`, static files in `public/`, and operational guidance in `docs/`. Treat `graphify-out/` and generated types as derived artifacts.

## Build, Test, and Development Commands

- `npm install` installs pinned dependencies.
- `npm run dev` starts the Vite frontend.
- `npm run db:local` applies D1 migrations to the local database.
- `npm run dev:worker` starts the Worker development server.
- `npm run typecheck` runs strict TypeScript checks.
- `npm test` runs the Vitest suite once.
- `npm run build` type-checks and creates the production frontend bundle.
- `npm run check` runs the full pre-PR gate, including a Wrangler dry-run deploy.
- `npm run types` regenerates Cloudflare binding types after `wrangler.jsonc` changes.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, double quotes, and trailing commas where supported. Name React components and classes in `PascalCase`, functions and variables in `camelCase`, and constants in `UPPER_SNAKE_CASE`. Keep route handlers small and verb-led, such as `createLaunch()` or `listTokens()`. Name migrations sequentially, for example `0003_add_trade_index.sql`. ESLint and TypeScript are the static-quality gate (`npm run check`); preserve surrounding style. Do not hand-edit generated `worker-configuration.d.ts`.

## Testing Guidelines

Vitest discovers `*.test.ts` files; existing economic invariant tests are in `shared/economics.test.ts`. Add focused regression tests beside shared domain logic and cover boundary values, rounding, supply conservation, validation, and authorization-sensitive behavior. No coverage threshold is configured, but changes to economics or security controls must include tests. Run `npm run check` before submitting.

## Commit & Pull Request Guidelines

Use concise Conventional Commit messages, for example `feat(worker): add trade webhook` or `fix(ui): reject invalid symbol`. Pull requests should explain user impact, list verification commands, link relevant issues, and include screenshots for visual changes. Call out new D1 migrations, bindings, environment variables, or deployment steps explicitly.

## Security & Configuration

Never commit `.dev.vars`, wallet keys, webhook secrets, or Turnstile credentials; store production values with Wrangler secrets. Validate untrusted input at Worker boundaries, use prepared D1 statements, and keep Solana as the authoritative source for settlement while Cloudflare storage acts as cache and index.
