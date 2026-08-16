// The version the server reports about itself (MCP serverInfo, spec §7.0).
// Read from package.json at runtime by the same nearest-package.json walk the
// migration resolver uses (db/client.ts): src/ and dist/src/ sit at different
// depths, so a relative JSON import cannot resolve from both — and letting tsc
// bundle one would emit dist/package.json, the exact file the layout invariant
// forbids (spec §10). A hardcoded constant is how 0.2.0 shipped introducing
// itself as 0.1.0.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function serverVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`Cannot locate the server package root above ${dir}`)
    dir = parent
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string') throw new Error('server package.json has no version')
  return pkg.version
}
