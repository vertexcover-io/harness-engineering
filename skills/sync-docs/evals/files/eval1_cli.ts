import { Command } from "commander";
import { deploy } from "./commands/deploy";
import { status } from "./commands/status";
import { rollback } from "./commands/rollback";
import { logs } from "./commands/logs";

const program = new Command();

program
  .name("myapp")
  .version("2.1.0")
  .description("CLI for managing deployments");

program
  .command("deploy")
  .description("Deploy the application")
  .option("--env <environment>", "Target environment", "staging")
  .option("--dry-run", "Preview changes without applying")
  .option("--timeout <seconds>", "Deployment timeout in seconds", "300")
  .option("--rollback-on-failure", "Automatically rollback if deployment fails")
  .action(deploy);

program
  .command("status")
  .description("Check deployment status")
  .option("--json", "Output as JSON")
  .action(status);

program
  .command("rollback")
  .description("Rollback to a previous deployment")
  .option("--version <version>", "Target version to rollback to")
  .option("--force", "Skip confirmation prompt")
  .action(rollback);

program
  .command("logs")
  .description("Stream deployment logs")
  .option("--follow", "Follow log output")
  .option("--since <duration>", "Show logs since duration (e.g., 1h, 30m)")
  .action(logs);

program.parse();
