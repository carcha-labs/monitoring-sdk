import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist', 'node_modules'] },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
        languageOptions: {
            globals: globals.node,
            parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js', 'scripts/*.mjs'] }, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            'no-warning-comments': 'error',
            'no-inline-comments': 'error',
            'no-console': ['error', { allow: ['warn'] }],
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        },
    },
    {
        files: ['eslint.config.js', 'scripts/*.mjs'],
        ...tseslint.configs.disableTypeChecked,
    },
    {
        files: ['scripts/*.mjs'],
        rules: { 'no-console': 'off' },
    },
);
