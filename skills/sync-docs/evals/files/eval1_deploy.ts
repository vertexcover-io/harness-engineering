import { DeploymentClient } from "../lib/client";

interface DeployOptions {
  env: string;
  dryRun?: boolean;
  timeout?: string;
  rollbackOnFailure?: boolean;
}

export async function deploy(options: DeployOptions): Promise<void> {
  const client = new DeploymentClient({
    region: process.env.MYAPP_REGION ?? "us-east-1",
    apiKey: process.env.MYAPP_API_KEY!,
    webhookUrl: process.env.MYAPP_WEBHOOK_URL,
    maxRetries: parseInt(process.env.MYAPP_MAX_RETRIES ?? "3"),
  });

  const timeout = parseInt(options.timeout ?? "300");

  if (options.dryRun) {
    const plan = await client.plan(options.env);
    console.log("Deployment plan:", JSON.stringify(plan, null, 2));
    return;
  }

  const result = await client.deploy(options.env, {
    timeout,
    rollbackOnFailure: options.rollbackOnFailure ?? false,
  });

  if (result.status === "failed" && options.rollbackOnFailure) {
    console.log("Deployment failed, initiating rollback...");
    await client.rollback(options.env);
  }

  console.log(`Deployment ${result.status}: ${result.url}`);
}
