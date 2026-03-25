# MyApp CLI

A command-line tool for managing deployments.

## Installation

```bash
npm install -g myapp-cli
```

## Commands

### `myapp deploy`

Deploy the application to the configured environment.

```bash
myapp deploy --env production
```

Options:
- `--env` — Target environment (default: `staging`)
- `--dry-run` — Preview changes without applying

### `myapp status`

Check the current deployment status.

```bash
myapp status
```

## Configuration

Set the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `MYAPP_API_KEY` | API key for authentication | — |
| `MYAPP_REGION` | Deployment region | `us-east-1` |

## Architecture

The CLI uses a plugin-based architecture. See `src/plugins/` for available plugins.

Entry point: `src/cli.ts` → routes to command handlers in `src/commands/`.
