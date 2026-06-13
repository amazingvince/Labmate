// ESLint flat config. Guardrails that catch the mistakes an autonomous agent
// is most likely to make in JS: unused vars, floating promises via no-undef on
// awaits, accidental console.log noise, loose equality, leftover debuggers.
// Intentionally light — this scaffold is JS + Python, not a TS build.
import js from "@eslint/js";

export default [
  {
    ignores: [
      "node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "apps/modal-runner/**",
      "examples/**/*.csv",
      "**/__pycache__/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Response: "readonly",
        Request: "readonly",
        crypto: "readonly",
        setTimeout: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      eqeqeq: ["error", "always"],
      "no-debugger": "error",
      "no-var": "error",
      "prefer-const": "error",
    },
  },
];
