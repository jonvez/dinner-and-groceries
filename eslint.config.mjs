import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Next 16's eslint-config-next ships native ESLint 9 flat config, so we
// import the flat arrays directly (no more FlatCompat/eslintrc wrapping).
const eslintConfig = [
  {
    // `.claude/worktrees/**` holds live agent worktrees — whole checkouts of
    // other branches. Without this, a local lint run reports every problem
    // twice (once here, once in each worktree) and can fail on half-finished
    // code that is not part of this branch at all.
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      ".claude/worktrees/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default eslintConfig;
