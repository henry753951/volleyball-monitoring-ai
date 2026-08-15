import { createConfigForNuxt } from '@nuxt/eslint-config'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

export default createConfigForNuxt({
  features: {
    stylistic: false,
    tooling: false,
  },
})
  .prepend({
    name: 'volleyball-monitoring/ignores',
    ignores: [
      '**/.artifacts/**',
      '**/.codex-dev/**',
      '**/.data/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/.playwright-cli/**',
      '**/coverage/**',
      '**/dist/**',
      '**/generated/**',
      '**/node_modules/**',
      '**/output/**',
      '**/tmp/**',
      'packages/contracts/flatbuffers/generated/**',
      'web/app/gql/**',
    ],
  })
  .append({
    name: 'volleyball-monitoring/vue-file-conventions',
    files: ['web/app/**/*.vue'],
    rules: {
      'vue/require-default-prop': 'off',
    },
  })
  .append({
    name: 'volleyball-monitoring/nuxt-route-and-ui-names',
    files: ['web/app/components/ui/*.vue', 'web/app/layouts/**/*.vue', 'web/app/pages/**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  })
  .append({
    name: 'volleyball-monitoring/test-and-tooling-pragmatism',
    files: ['**/*.test.ts', '**/*.integration.test.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-loss-of-precision': 'off',
    },
  })
  .append({
    name: 'volleyball-monitoring/binary-parser-regex',
    files: ['server/src/media/minio-object-reader.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  })
  .append(eslintConfigPrettier)
