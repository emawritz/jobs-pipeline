import { scoreJob } from "../lib/score.ts";

const fakeJob = {
  source: "test",
  url: "https://example.com/job",
  company: "Linear",
  title: "Senior Product Engineer",
  text: `Linear is hiring a Senior Product Engineer to join our small engineering team.
Stack: TypeScript, Node, GraphQL, Postgres, Electron.
Remote-first, Americas-friendly. Salary $160-220k USD + equity.
We ship every day. You'll own features end-to-end from design to production.`,
  salary: "$160-220k USD",
};

const t0 = Date.now();
scoreJob(fakeJob).then((s) => {
  console.log(JSON.stringify(s, null, 2));
  console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s]`);
});
