// @ts-check
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".expo/**",
      "node_modules/**",
      "babel.config.js",
      "expo-env.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // Classic react-hooks rules only — exhaustive-deps + rules-of-hooks.
      // The v7 compiler rules (set-state-in-effect, no-refs-during-render, etc.)
      // require React compiler adoption; not enabled here.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Allow `any` freely in an Expo app — strict typing lives in shared packages
      "@typescript-eslint/no-explicit-any": "off",
      // Unused vars: warn only, ignore _-prefixed intentional ones
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Expo router uses `require()` for assets
      "@typescript-eslint/no-require-imports": "off",
    },
  }
);
