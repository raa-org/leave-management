/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The .env files live at the workspace root (shared with the backend), so point
// Vite there for both loading and VITE_* exposure.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, 'VITE_')
  const rawBasePath = (env.VITE_BASE_PATH ?? '').trim()
  // Dev-only: where the `vite dev` proxy forwards /api. Keep personal ports in
  // the gitignored .env, not here, so one dev's setup never breaks the others.
  const apiProxyTarget =
    (env.VITE_API_PROXY_TARGET ?? '').trim() || 'http://localhost:3000'
  // Vite's `base` must be "/" or "/path/"; normalize empty/"/" to "/".
  const withoutTrailing = rawBasePath.replace(/\/+$/, '')
  const base = withoutTrailing === '' ? '/' : `${withoutTrailing}/`

  return {
    plugins: [react()],
    base,
    envDir: workspaceRoot,
    define: {
      // Build timestamp baked into the bundle (dev server start time under
      // `vite serve`). Logged to the browser console from main.tsx.
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    resolve: {
      alias: {
        // Resolve the workspace contracts to its TypeScript source so Vite
        // serves it as native ESM. Its built CJS dist uses runtime
        // `__exportStar` re-exports, which Vite's dev CJS->ESM interop cannot
        // read statically, breaking named value exports (e.g. the
        // LeaveRequestStatus enum) with "doesn't provide an export named ...".
        '@workspace/contracts': resolve(
          workspaceRoot,
          'libs/shared/contracts/src/index.ts',
        ),
      },
      dedupe: ['react', 'react-dom'],
      preserveSymlinks: true,
    },
    server: {
      // Match FRONTEND_URL so post-login OIDC redirects and email links line up.
      port: 4200,
      // Allow serving the aliased contracts source from libs/ (outside apps/web).
      fs: { allow: [workspaceRoot] },
      // Proxy API calls to the backend, stripping the /api prefix the same way
      // the production nginx / runtime proxy does (controllers have no /api).
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  }
})
