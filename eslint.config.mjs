import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import eslintConfigPrettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // mobile/ is the Pi Remote app: its own package with its own tooling.
    ignores: ['out', 'dist', 'release', 'coverage', 'node_modules', 'mobile']
  },
  eslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    }
  },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'],
  eslintConfigPrettier
)
