import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = resolve(root, 'packages/contracts/graphql/schema.graphql')
const operationsRoot = resolve(root, 'packages/contracts/graphql/operations')
const requireFromServer = createRequire(resolve(root, 'server/package.json'))
const { buildSchema, parse, validate } = requireFromServer('graphql')

function graphqlDocuments(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return graphqlDocuments(path)
      return extname(entry.name) === '.graphql' ? [path] : []
    })
    .sort()
}

const schema = buildSchema(readFileSync(schemaPath, 'utf8'))
const operationPaths = graphqlDocuments(operationsRoot)
if (operationPaths.length === 0) {
  throw new Error('No GraphQL operation documents found')
}

const failures = []
for (const operationPath of operationPaths) {
  const document = parse(readFileSync(operationPath, 'utf8'))
  for (const error of validate(schema, document)) {
    failures.push(`${relative(root, operationPath)}: ${error.message}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`GraphQL operation validation passed (${operationPaths.length} documents)`)
