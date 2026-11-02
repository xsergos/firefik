# React + TypeScript + Vite

Built with [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react), which transforms JSX and TypeScript with [Oxc](https://oxc.rs). The React Compiler is not enabled.

## Type-checking and linting

- `npm run type-check` runs `tsc -b` from TypeScript 7 (the native compiler).
- `npm run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter) with
  [.oxlintrc.json](.oxlintrc.json): the ESLint and typescript-eslint
  recommended rules, React hooks rules including the React Compiler checks,
  and `react/only-export-components` for fast refresh. Errors fail the
  command; warnings do not.
- `npm run format:check` runs Prettier.

## Running E2E tests locally

Playwright smoke + apply/disable tests in [e2e/smoke.spec.ts](e2e/smoke.spec.ts)
run against a real backend + Caddy stack via docker compose. Start the
stack with the test overrides and point Playwright at it:

```bash
# From repo root
export FIREFIK_API_TOKEN=e2e-test-token
export FIREFIK_HTTP_PORT=8080
docker compose -f docker-compose.yml -f docker-compose.e2e.yml up -d --wait

cd frontend
npm ci
npx playwright install --with-deps chromium
PLAYWRIGHT_BASE_URL=http://localhost:8080 npx playwright test
```

The E2E override boots an extra `mock-target` nginx container with
`firefik.enable=true` labels so the Containers page has something to
apply rules to. When the mock target isn't present (e.g. `vitest` unit
runs), the apply/disable test skips itself instead of failing.

CI runs the same sequence in the `e2e` job of
[.github/workflows/ci.yml](../.github/workflows/ci.yml); the Playwright
HTML report and compose logs are uploaded as artifacts on failure.

Tear down with:

```bash
docker compose -f docker-compose.yml -f docker-compose.e2e.yml down -v
```
