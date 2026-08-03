// Bundles the APT TS modules + engine into a runnable Node ESM bundle.
// Resolves the Vite aliases (@/, @ipc), replaces browser modules with shims
// (vue, @/web/background/IPC, @/web/Config) and maps `import.meta.env` onto
// globalThis.__aptEnv (BASE_URL is set at runtime, no hardcoding).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))          // backend/v2
const repoRoot = path.resolve(here, '../..')

// esbuild is a declared devDependency of this package. It used to be loaded by
// absolute path out of renderer/node_modules, where it only ever appeared as a
// transitive dependency of vite — so the build silently depended on a package
// nobody had asked for, and removing vite would have broken it.
const srcDir = path.join(repoRoot, 'renderer', 'src')
const ipcDir = path.join(repoRoot, 'ipc')
const shimDir = path.join(here, 'shims')

const aliasPlugin = {
  name: 'apt-alias',
  setup (build) {
    build.onResolve({ filter: /^vue$/ }, () => ({ path: path.join(shimDir, 'vue.mjs') }))
    build.onResolve({ filter: /^@\/web\/background\/IPC$/ }, () => ({ path: path.join(shimDir, 'ipc-host.mjs') }))
    build.onResolve({ filter: /^@\/web\/Config$/ }, () => ({ path: path.join(shimDir, 'config.mjs') }))

    build.onResolve({ filter: /^@ipc(\/|$)/ }, (args) => {
      const sub = args.path.replace(/^@ipc/, '')
      const target = sub ? path.join(ipcDir, sub) : ipcDir
      return build.resolve(target, { kind: args.kind, resolveDir: ipcDir })
    })
    build.onResolve({ filter: /^@\// }, (args) => {
      const target = path.join(srcDir, args.path.slice(2))
      return build.resolve(target, { kind: args.kind, resolveDir: srcDir })
    })
  }
}

await esbuild.build({
  entryPoints: [path.join(here, 'engine.mts')],
  outfile: path.join(here, 'engine.bundle.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  resolveExtensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.json'],
  define: { 'import.meta.env': 'globalThis.__aptEnv' },
  // object-hash (CJS, via Cache.ts) calls require('crypto'); provide require in the ESM bundle
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [aliasPlugin],
  logLevel: 'info',
  logOverride: { 'unsupported-dynamic-import': 'silent' }
})

console.log('built -> backend/v2/engine.bundle.mjs')
