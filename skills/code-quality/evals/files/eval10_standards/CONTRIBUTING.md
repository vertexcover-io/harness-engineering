# Contributing

## Code conventions

- Exported factory functions use `PascalCase` (e.g. `CreateUserSession`), not camelCase.
- Expected business failures **throw** typed error subclasses of `AppError`. We do not use
  Result/Either return values anywhere in this codebase — our error middleware depends on
  exceptions propagating.
- Every exported symbol carries a JSDoc block, including a `@since` tag.
