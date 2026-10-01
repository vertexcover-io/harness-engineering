#!/usr/bin/env bun
// A fake ticket tracker for the ticket-demo workflow: prints a made-up ticket as JSON.

const KEY_PATTERN = /^DEMO-\d+$/;

const demoTicket = (key: string) => ({
  id: `demo-${key.toLowerCase()}`,
  key,
  name: "Add CSV export to the reports page",
  url: `https://tickets.example.com/browse/${key}`,
  status: "In Progress",
  assignee: "Sam Lee",
  labels: ["reports", "export"],
  priority: "High",
  body: [
    "Users want to download the monthly report as a CSV file.",
    "",
    "- Add an Export CSV button next to Print.",
    "- One row per line item; columns match the table on screen.",
    "- Design notes: https://design.example.com/reports-export",
  ].join("\n"),
  comments: [
    { id: "c1", author: "Priya", body: "Dates should use ISO format, not the locale format." },
    { id: "c2", author: "Sam Lee", body: "Agreed. I'll keep the column order from the table." },
  ],
});

const main = (argv: readonly string[]): void => {
  const [command, key] = argv;
  if (command !== "issue" || key === undefined || !KEY_PATTERN.test(key)) {
    console.error("usage: bun demo-workflows/scripts/demo-tickets.ts issue DEMO-NUMBER");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(demoTicket(key), null, 2));
};

main(process.argv.slice(2));
