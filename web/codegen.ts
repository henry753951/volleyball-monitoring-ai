
import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: '../packages/contracts/graphql/schema.graphql',
  documents: ['graphql/**/*.graphql', 'app/**/*.{vue,ts}'],
  generates: {
    'graphql/generated/': {
      preset: 'client',
      config: {
        strictScalars: true,
        defaultScalarType: 'unknown',
        scalars: {
          Int64: 'string',
          BigInt: 'string',
          DateTime: 'string',
          JSON: 'unknown',
        },
      },
    },
  },
  ignoreNoDocuments: true,
}

export default config
