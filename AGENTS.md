# SuperRare Connect Agent Guide

This guide applies to the entire repository.

## Project Purpose

`@superrare/connect` is a public TypeScript SDK for starting SuperRare-hosted Connect flows from external websites.

The package should support:

- browser-first SDK usage from modern bundlers
- direct browser embed builds
- hosted SuperRare auth, checkout, bid, offer, and status flows
- strict runtime validation at external boundaries
- a small, intentional public API

The SDK is not the wallet, payment, or contract execution layer. Wallet connection, transaction execution, payment handling, and sensitive auth work happen on SuperRare-controlled origins.

## Development Commands

Use the package manager declared in `package.json`.

```bash
pnpm install
pnpm test
pnpm build
```

Before considering a normal code change complete, run at least:

```bash
pnpm test
pnpm build
```

For documentation-only changes, tests are not required, but say that explicitly in the final response.

## General Rules

- Write TypeScript source. Do not author JavaScript source files directly unless they are unavoidable tool configuration files.
- Use complete words instead of abbreviations, except standard terms such as API, URL, SDK, ID, HTML, ESM, CJS, and DOM.
- Prefer `const` by default. Use `let` only when reassignment is genuinely required.
- Create new arrays and objects instead of mutating existing values.
- Prefer functional array methods such as `map`, `filter`, `reduce`, `some`, and `every` when they keep the code clear.
- Remove unused imports when updating a module.
- Keep package exports intentional. Anything exported from the package entrypoint is public API and should be documented, tested, and treated as semver-significant.
- Do not hardcode values just to satisfy tests.
- Do not add secrets, API keys, private keys, session IDs, or production-only credentials to examples, tests, docs, or config.

## Verification First

Do not rely on memory for API contracts, package behavior, or security-sensitive flows.

- Re-read the relevant source, tests, schemas, package exports, and docs before changing them.
- Verify Rare API request and response shapes before updating SDK client behavior.
- Treat backend responses, browser storage, callback query parameters, and user input as untrusted until validated.
- If information is missing and cannot be discovered from the repo, call out the assumption explicitly.

## Architecture

Keep business decisions easy to test and side effects easy to audit.

Pure SDK logic should take plain inputs and return plain outputs. Use it for validation, normalization, transformations, request planning, branching rules, and domain decisions. It should not perform HTTP calls, browser navigation, storage access, logging, timers, process behavior, or other I/O.

Side-effecting code should be thin and explicit. Use it for calling Rare API, reading or writing browser storage, redirecting the browser, using `fetch`, reading `globalThis`, notifying listeners, and other environment interactions. Side-effecting code should pass plain data into pure helpers and act on structured results.

When adding behavior:

- Put input-dependent decisions in pure helpers.
- Return structured discriminated results from pure validation logic.
- Keep browser navigation, storage, `fetch`, and listener notification out of pure helpers.
- Do not opportunistically refactor unrelated working code into this shape unless the task requires it.

## TypeScript Standards

Use strict TypeScript as part of the design, not as a post-hoc compiler exercise.

- Do not use `any`.
- Do not use type assertions with `as` or angle-bracket assertions. Prefer narrowing, type predicates, discriminated unions, generics with constraints, and Zod parsing at boundaries.
- Avoid non-null assertions.
- Prefer `type` aliases for object shapes and unions.
- Use explicit function return types for exported functions and non-trivial internal functions.
- Model expected states with discriminated unions rather than boolean flags when callers need to branch on outcomes.
- Exhaustively handle unions. If a switch over a union gains a new case, the compiler should force the missing handling.
- Keep `noUncheckedIndexedAccess` in mind. Handle possibly missing indexed values directly.

`as const` can be acceptable for literal inference when there is no safer alternative. Do not use it to paper over an imprecise model.

## Zod And Boundary Parsing

Use Zod for untrusted or unknown data:

- HTTP responses
- callback query parameters if parsed from generic input
- browser storage
- JSON parsing
- user-provided configuration
- environment variables, if this repo adds Node tooling or CLI behavior

Schema rules:

- Name schemas in camelCase, for example `connectSessionSchema`.
- Infer TypeScript types from schemas with `z.infer<typeof schema>`.
- Parse as close to the trust boundary as possible.
- Treat raw `response.json()` and `JSON.parse()` results as `unknown`.

Do not re-parse values TypeScript already knows. If a value is already typed, construct the next shape explicitly with an object literal or a pure mapper instead of running it through a schema again.

## Errors And Results

Use this rule of thumb: if the caller should branch on the failure, return a discriminated result; if the operation crossed an I/O boundary or the failure should abort the operation, throw.

Return discriminated results from pure helpers for expected validation failures:

```ts
type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: 'invalid_input' };
```

Throw from shell and public async SDK methods when:

- Rare API returns an error
- browser storage or navigation behavior fails unexpectedly
- callback exchange cannot proceed
- an invariant is impossible and indicates a programmer error

Custom errors should carry fields callers can inspect, such as `status`, `path`, or a stable `code`. Preserve original errors with `cause` when wrapping adds useful context.

Avoid:

- boolean-only failure returns
- swallowing caught errors
- catch-and-rethrow without adding useful context
- `console.error` or `process.exit` inside reusable SDK code

## Browser SDK Requirements

The core package must remain browser-safe and framework-agnostic.

- Do not add React, Next.js, Reown, wagmi, viem, ethers, Coinflow, or contract ABI dependencies to the core SDK unless a task explicitly requires and justifies them.
- Do not access Node-only globals from browser SDK code.
- Keep default navigation and storage injectable for tests and custom integrations.
- Allow disabled navigation and storage modes for controlled environments when the public API supports them.
- Keep direct DOM usage inside examples, not the SDK core.

Hosted flow safety rules:

- Public parameters should use `returnPath`, not `returnUrl`.
- `returnPath` must be same-origin relative.
- Reject absolute URLs.
- Reject protocol-relative URLs.
- Reject backslashes.
- Reject encoded slash or backslash bypasses.
- Reject control characters.
- Generate auth `state` with secure browser crypto by default.
- Verify callback `state` and intent identifiers against pending auth before exchanging a code.
- Never accept arbitrary calldata or transaction instructions from SDK consumers.

## CLI Or Tooling Guidance

If this repo adds CLI scripts, release tooling, code generation, or MCP-like tooling, keep the same separation between pure logic and side effects.

- CLI commands should be thin wrappers around SDK or pure helpers.
- Put command option normalization and validation in pure functions.
- Keep filesystem access, environment reads, process exits, and terminal output in shell modules.
- Throw from command actions and let the top-level command runner format errors.
- Do not print directly from pure helpers.
- Use Zod for environment variables, config files, generated JSON, and external command output.

## Package Design

Treat package metadata and build outputs as part of the product.

- Keep `package.json` `exports` aligned with files emitted by the build.
- Keep `types` pointed at generated declarations.
- Keep `sideEffects: false` unless a real side effect is introduced at module import time.
- Do not introduce import-time browser side effects.
- Keep examples out of the package runtime.
- Ensure direct browser builds, if present, expose a stable global with documented names only.

Before adding a public export, ask:

- Would an external integrator import this directly?
- Are we ready to document it?
- Is it tested as public behavior?
- Would changing it require a semver-conscious decision?

If the answer is no, keep it internal.

## Import Style

Follow the existing repo import style unless the task adds a configured alias.

- Use explicit `.js` extensions in TypeScript imports when required by the ESM build setup.
- Prefer sibling relative imports for local package modules.
- Avoid fragile parent traversal in source code. If the repo grows enough that imports become hard to follow, configure a source alias in `tsconfig.json` and the build/test tools before using it.
- Keep type-only imports as type imports.

## Testing Approach

Use the cheapest test that gives real confidence.

Unit tests should focus on pure SDK behavior:

- input normalization
- callback parsing
- pending auth verification
- request builders
- status resolution
- storage serialization and parsing

Shell and SDK tests should cover observable SDK behavior:

- API request methods and headers
- response validation
- browser storage reads and writes
- navigation assignment
- callback exchange
- session listeners
- storage-disabled and navigation-disabled modes
- package build outputs when build behavior changes

Examples should build or typecheck when their dependencies are present. Do not let examples silently drift away from the public API.

## Documentation

Docs and examples must be copy-pasteable and clear about what the SDK does and does not do.

Document:

- install command
- bundler import
- direct browser embed usage
- auth login flow
- callback exchange flow
- session and user helpers
- checkout flow
- bid and offer flows
- intent/status polling
- configuration options
- error handling
- local development commands

Do not imply integrators need wallet libraries, blockchain providers, private keys, API secrets, or contract ABIs to use SuperRare Connect.

## Review Checklist

Before finishing a change, verify:

- Pure logic is separated from side effects.
- Boundary data is parsed with Zod.
- Typed values are not redundantly re-parsed.
- No type assertions or `any` were introduced.
- Public exports are intentional.
- Browser security rules still hold.
- Tests cover meaningful behavior.
- `pnpm test` and `pnpm build` pass, unless the task is docs-only or you explicitly explain why checks could not run.
