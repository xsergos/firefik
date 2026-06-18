# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.node.json", "./tsconfig.app.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from "eslint-plugin-react-x";
import reactDom from "eslint-plugin-react-dom";

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs["recommended-typescript"],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.node.json", "./tsconfig.app.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```

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
