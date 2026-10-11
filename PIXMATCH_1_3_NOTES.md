# PixMatch 1.3

- Built from 1.1 (3.17.1 code). No app features changed.
- `bun.lock` and any `package-lock.json` removed.
- `package.json` `overrides` now pin the patched TanStack packages everywhere in the dependency tree:
  `@tanstack/react-start` 1.168.60, `@tanstack/react-router` 1.170.41, `@tanstack/start-server-core` 1.169.39.
  This stops Vercel's 403 on `start-server-core@1.169.17`.

## Upload to GitHub
Keep the folder structure (drag the folders, not the files inside them). The repo root must contain
`src`, `public`, `docs`, `.lovable`, `package.json`, `vite.config.ts`, `tsconfig.json`. Delete any `bun.lock` or `package-lock.json` in the repo.
