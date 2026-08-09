import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import restrictedGlobals from "confusing-browser-globals";
import importPlugin from "eslint-plugin-import";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: [
      "src/**/*.{ts,tsx}",
      "cloud/workers/api/**/*.ts",
      "scripts/deploy-cloudflare-api*.ts",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      parser: tsParser,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
      "jsx-a11y": jsxA11y,
      react,
      "react-hooks": reactHooks,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.flat.recommended.rules,
      "no-array-constructor": "off",
      "no-dupe-class-members": "off",
      "no-redeclare": "off",
      "no-undef": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-expressions": "off",
      "no-unused-vars": "off",
      "no-use-before-define": "off",
      "no-useless-constructor": "off",
      "no-mixed-operators": [
        "error",
        {
          groups: [["&&", "||"]],
          allowSamePrecedence: true,
        },
      ],
      "no-restricted-globals": ["error", ...restrictedGlobals],
      "@typescript-eslint/consistent-type-assertions": "warn",
      "@typescript-eslint/no-array-constructor": "warn",
      "@typescript-eslint/no-redeclare": "warn",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        {
          allowShortCircuit: true,
          allowTernary: true,
          allowTaggedTemplates: true,
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "none",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-use-before-define": [
        "warn",
        {
          functions: false,
          classes: false,
          variables: false,
          typedefs: false,
        },
      ],
      "@typescript-eslint/no-useless-constructor": "warn",
      "import/first": "error",
      "import/no-amd": "error",
      "import/no-anonymous-default-export": "warn",
      "import/no-webpack-loader-syntax": "error",
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/jsx-uses-react": "off",
      "react/no-unknown-property": ["error", { ignore: ["onLoad"] }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "jsx-a11y/alt-text": "warn",
      "jsx-a11y/anchor-has-content": "warn",
      "jsx-a11y/anchor-is-valid": [
        "warn",
        {
          aspects: ["noHref", "invalidHref"],
        },
      ],
      "jsx-a11y/aria-activedescendant-has-tabindex": "warn",
      "jsx-a11y/aria-props": "warn",
      "jsx-a11y/aria-proptypes": "warn",
      "jsx-a11y/aria-role": ["warn", { ignoreNonDOM: true }],
      "jsx-a11y/aria-unsupported-elements": "warn",
      "jsx-a11y/heading-has-content": "warn",
      "jsx-a11y/iframe-has-title": "warn",
      "jsx-a11y/img-redundant-alt": "warn",
      "jsx-a11y/no-access-key": "warn",
      "jsx-a11y/no-distracting-elements": "warn",
      "jsx-a11y/no-redundant-roles": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
      "jsx-a11y/scope": "warn",
    },
  },
];
