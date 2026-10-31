import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated files: the API client from openapi-ts and the route tree from the router plugin.
  { ignores: ["dist", "node_modules", "src/routeTree.gen.ts", "src/api/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx,js}"],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The server CSP (default-src 'self') blocks inline style and script elements.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='createElement'][arguments.0.value=/^(style|script)$/]",
          message: "The CSP default-src 'self' blocks injected style and script elements.",
        },
        {
          selector: "JSXOpeningElement[name.name=/^(style|script)$/]",
          message: "The CSP default-src 'self' blocks inline style and script elements.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@radix-ui/react-dialog", "@radix-ui/react-select", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@radix-ui/react-alert-dialog", "react-remove-scroll"],
              message: "These pull in react-remove-scroll, which injects a style element that the CSP blocks. Use the native dialog or select.",
            },
          ],
        },
      ],
    },
  },
);
