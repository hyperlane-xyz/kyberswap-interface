# KyberSwap Interface

Unified frontend monorepo for Kyber Network's DeFi products (Aggregator, Limit Orders, Zap Widgets, Cross-Chain Swaps).

## Quick Start

```bash
pnpm i                                    # Install dependencies
pnpm build-package                        # Build shared packages (REQUIRED before running apps)
cd apps/kyberswap-interface && pnpm dev    # Run main interface
```

## Development Commands

| Command              | Purpose                        |
| -------------------- | ------------------------------ |
| `pnpm i`             | Install all dependencies       |
| `pnpm build-package` | Build shared packages only     |
| `pnpm build`         | Build everything               |
| `pnpm lint`          | Run ESLint across all packages |
| `pnpm type-check`    | TypeScript validation          |

## Before Committing

```bash
pnpm lint
pnpm type-check
pnpm build
```

## Tech Stack

- React 18 + TypeScript + Vite
- pnpm workspaces + Turborepo
- styled-components (no CSS modules, no inline styles)
- Redux Toolkit + RTK Query (app state), zustand (widget state)
- ethers.js, wagmi, viem

## Code Conventions

- Functional components with hooks only
- TypeScript strict mode, no unjustified `any`
- Components: `PascalCase.tsx`, Hooks: `useCamelCase.ts`, Utils: `camelCase.ts`
- Import order: external libs → `@kyberswap/*` → local imports → types → styles

## Code Quality Rules (MUST follow)

When writing or modifying code, **always** ensure the result is free of:

1. **TypeScript errors/warnings** — no `any` unless absolutely necessary (and justified with a comment), no implicit `any`, no unused variables/imports, no type mismatches. Run mental type-checking on every change.
2. **ESLint violations** — follow all project ESLint rules. Key rules include:
   - No unused imports or variables (`unused-imports/no-unused-imports`)
   - Proper React hooks dependency arrays (`react-hooks/exhaustive-deps`)
   - Proper import ordering
3. **Prettier formatting** — all code must match the project's Prettier config (single quotes, trailing commas, semicolons, print width). Format code consistently.

**Workflow (MANDATORY)**: After making any code changes, you **MUST** run the following commands on the affected package(s) and fix all errors before considering the task done:

```bash
pnpm lint          # Fix all ESLint errors/warnings
pnpm type-check    # Fix all TypeScript errors
```

Format all modified files with Prettier. Do **NOT** present code changes as complete until these checks pass with zero errors. If any check fails, fix the issues and re-run until clean.

## Color & Styling Rules

- **Always use theme colors** — never hardcode hex/rgb values. Use `${({ theme }) => theme.colorName}` in styled-components. Check `src/theme/color.ts` for existing tokens before introducing new colors.
- Key tokens: `primary`, `text`, `subText`, `background`, `border`, `red1`, `warning`, `buttonBlack`, `buttonGray`, `tableHeader`, etc.

## Number Formatting Rules

- **Always reuse existing formatters** — before writing any number formatting logic, check the existing utilities:
  - `formatDisplayNumber()` from `utils/numbers.ts` (app-level, supports `decimal`/`currency`/`percent`)
  - `formatDisplayNumber()`, `formatTokenAmount()`, `formatCurrency()`, `formatNumber()`, `formatWei()`, `formatAprNumber()` from `@kyberswap/utils`
  - `formatTokenBalance()`, `formatBigLiquidity()`, `formatLongNumber()` from `utils/formatBalance.ts`
- Do **not** use deprecated formatters (`formatDollarAmount`, `formattedNum`, `formatCurrencyAmount`).

You are operating in a pnpm-workspace + turbo monorepo.

Rules:

- Follow existing code patterns.
- Keep diffs minimal.
- Avoid dependency/tooling changes unless requested.
- Avoid changing lockfiles unless necessary.

When responding:

- Provide file paths + code.
- Provide a short manual test plan.

# KyberSwap Development Rules

## Package Manager

- Use `pnpm` exclusively (not npm or yarn)
- Run `pnpm build-package` after modifying any shared package

## TypeScript

- Strict mode enabled - no `any` types without justification
- Use explicit return types for exported functions
- Prefer `interface` over `type` for object shapes

## React Patterns

- Functional components only (no class components)
- Use hooks for all state and side effects
- Destructure props in function signature

## Styling

- Use styled-components exclusively
- No inline styles, CSS modules, or Tailwind
- Theme values from `src/theme`

## Imports

Order imports as follows:

1. React and external libraries
2. Internal packages (`@kyberswap/*`)
3. Local absolute imports
4. Relative imports
5. Type imports
6. Style imports

## State Management

- Redux Toolkit for global app state
- RTK Query for API/server state
- Zustand for widget-local state
- useState for component-local state

## File Naming

- Components: `PascalCase.tsx`
- Hooks: `useCamelCase.ts`
- Utils: `camelCase.ts`
- Constants: `SCREAMING_SNAKE_CASE`

## Before Committing

Always run:

```bash
pnpm lint
pnpm type-check
```

## Widget Packages

When working in `packages/*-widgets/`, read `.agents/skills/widget-development/SKILL.md` before editing or reviewing.

## Agent Skills

Shared skills live in `.agents/skills/<name>/SKILL.md` and follow the [Agent Skills standard](https://agentskills.io/specification). Read a matching skill before using its workflow. Claude Code discovers the same files through the `.claude/skills` symlink; edit the files in `.agents/skills`. Use Claude Code v2.1.277 or later for native `AGENTS.md` loading.
