import { guessEmails } from "../lib/email-guesser.ts";

async function main() {
  const tests = [
    "Tinybird",
    "Factor IT",
    "BC Tecnología",
    "NeuralWorks",
    "EasyAudit AI, Inc.",
    "2BRAINS",
    "Coderslab.io",
  ];

  for (const company of tests) {
    const result = await guessEmails({ company });
    console.log(`\n${company.padEnd(30)} →`);
    if (result.length === 0) console.log("  (sin MX válido)");
    else for (const r of result) console.log("  ✓ " + r.email);
  }
}
main().catch(console.error);
