import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { printSchema } from 'graphql'
import { schema } from './schema.js'

const output = resolve(process.cwd(), '../packages/contracts/graphql/schema.graphql')
await writeFile(output, `${printSchema(schema)}\n`, 'utf8')
console.info(`GraphQL SDL written to ${output}`)
