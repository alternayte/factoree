import tseslint from "typescript-eslint";

export default tseslint.config(
  // `tests/live/*.mjs` holds the two acceptance-live module loaders, and `tools/local/*.mjs`
  // holds the operator scripts. They are not TypeScript files, and no tsconfig project contains
  // them, so the typed config cannot parse them.
  // `ui/` is its own npm project with its own ESLint config, and `npm run ui:lint` runs it.
  // `.claude/` holds agent worktrees, which are other checkouts of this repository.
  { ignores: ["dist/**", "node_modules/**", "*.mjs", "tests/live/*.mjs", "tools/local/*.mjs", "ui/**", ".claude/**"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["src/domain/**/*.ts", "src/workflows/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@linear/sdk*", "@prisma/client*", "octokit*", "@octokit/*"],
              message: "Provider SDKs belong in src/adapters (SDD section 14)."
            }
          ]
        }
      ]
    }
  },
);
