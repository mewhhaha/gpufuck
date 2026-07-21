import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: ["dist", "node_modules", "public/generated"],
  plugins: ["typescript", "react", "jsx-a11y"],
  rules: {
    "react/jsx-key": "error",
    "typescript/no-explicit-any": "error",
  },
});
