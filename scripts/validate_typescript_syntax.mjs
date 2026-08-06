import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignored = new Set(['node_modules', '.git', '.nuxt', '.output', 'dist', 'generated'])
const files = []

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.ts')) files.push(full)
    else if (entry.name.endsWith('.vue')) files.push(full)
  }
}

walk(root)
const failures = []
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const sources = []
  if (file.endsWith('.vue')) {
    const pattern = /<script(?:\s+setup)?(?:\s+lang=["']ts["'])?[^>]*>([\s\S]*?)<\/script>/g
    for (const match of raw.matchAll(pattern)) sources.push(match[1])
  } else {
    sources.push(raw)
  }

  for (const source of sources) {
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
      fileName: file,
      reportDiagnostics: true,
    })
    for (const diagnostic of output.diagnostics ?? []) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue
      failures.push(`${path.relative(root, file)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`typescript/vue syntax validation passed (${files.length} files)`) 
