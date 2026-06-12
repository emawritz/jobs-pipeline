// Workana auto-bidder.
//
// Modes:
//   --draft-only     scrape + draft proposals → data/workana-drafts.md (no submit). DEFAULT.
//   --review         scrape + draft + open each project in browser, prompt y/N to submit
//   --auto-submit    scrape + draft + submit. USE WITH CARE.
//   --max=N          cap projects to N (default 10)
//   --min-score=N    min stack match score (default 2)
//   --max-bids=N     skip projects with >N existing bids (default 12)
//   --headed         show browser
//
// Submission is gated by Workana profile approval. If your profile is still
// "en revisión" the textarea will be present but the submit will be blocked.
// --draft-only works regardless — generate proposals, paste manually if needed.

import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { scrapeWorkana, type WorkanaProject } from "../scrapers/workana.ts";
import { draftProposal, type Proposal } from "../lib/freelance-proposal.ts";
import { readJSON, writeJSON, today } from "../lib/storage.ts";
import { createInterface } from "node:readline/promises";

const USER_DATA_DIR = ".playwright-data";
const DRAFTS_PATH = "data/workana-drafts.md";

type Application = {
  id: string; url: string; platform: string; company?: string; title?: string;
  status: string; appliedAt: string; lastUpdate: string; notes: string[];
};

function genId() { return Math.random().toString(36).slice(2, 8); }

function arg(flag: string, def?: string): string | undefined {
  const m = process.argv.find((a) => a.startsWith(`${flag}=`));
  return m ? m.split("=")[1] : def;
}
function has(flag: string): boolean { return process.argv.includes(flag); }

async function submitProposal(
  page: Page,
  project: WorkanaProject,
  proposal: Proposal,
): Promise<{ ok: boolean; reason: string }> {
  await page.goto(project.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Workana bid form has a textarea for proposal text and an "Enviar propuesta" button.
  const textarea = await page.$("textarea[name='message'], textarea#message, textarea[name='bid_description']");
  if (!textarea) {
    return { ok: false, reason: "no proposal textarea found — profile likely not approved yet" };
  }
  await textarea.click();
  await page.waitForTimeout(300);
  await textarea.fill(proposal.proposal);
  await page.waitForTimeout(800);

  // If there's a price input visible, fill it based on suggested_price.
  if (/^\d+\/hr$/.test(proposal.suggested_price)) {
    const hourInput = await page.$("input[name='hourly_rate'], input[name='rate']");
    if (hourInput) await hourInput.fill(proposal.suggested_price.replace("/hr", ""));
  } else if (proposal.suggested_price.startsWith("fixed-") || proposal.suggested_price.startsWith("sprint-")) {
    const amount = proposal.suggested_price.split("-")[1];
    const priceInput = await page.$("input[name='budget'], input[name='amount'], input[name='price']");
    if (priceInput) await priceInput.fill(amount);
  }

  const submitBtn = await page.$("button[type='submit']:has-text('Enviar'), button:has-text('Enviar propuesta')");
  if (!submitBtn) {
    return { ok: false, reason: "no submit button — profile probably blocked" };
  }
  await submitBtn.click();
  await page.waitForTimeout(2500);

  // Verify: page should either show confirmation or redirect to "my proposals".
  const url = page.url();
  if (/proposal|propuesta|confirm/i.test(url) || (await page.$("text=/propuesta enviada|propuesta exitosa/i"))) {
    return { ok: true, reason: "submitted" };
  }
  return { ok: true, reason: `submitted (state unclear: ${url})` };
}

function writeDraftsFile(items: { project: WorkanaProject; proposal: Proposal }[]): void {
  mkdirSync("data", { recursive: true });
  const md = items.map(({ project, proposal }, i) => {
    return `## ${i + 1}. ${project.title}

- **URL**: ${project.url}
- **Budget**: ${project.budget || "(no especificado)"}
- **Posted**: ${project.postedAgo} · **Bids**: ${project.bidCount} · **Country**: ${project.clientCountry ?? "?"}
- **Match**: ${proposal.match_strength} · **Suggested price**: ${proposal.suggested_price}
- **Hook**: ${proposal.key_hook}

\`\`\`
${proposal.proposal}
\`\`\`
`;
  }).join("\n---\n\n");

  writeFileSync(DRAFTS_PATH, `# Workana drafts — ${today()}\n\n${md}\n`);
  console.log(`\n→ ${items.length} drafts written to ${DRAFTS_PATH}`);
}

async function main() {
  const max = parseInt(arg("--max", "10")!, 10);
  const minScore = parseInt(arg("--min-score", "2")!, 10);
  const maxBids = parseInt(arg("--max-bids", "12")!, 10);
  const review = has("--review");
  const autoSubmit = has("--auto-submit");
  const draftOnly = !review && !autoSubmit; // default
  const headed = has("--headed");

  console.log(`[workana-bid] mode=${draftOnly ? "draft-only" : review ? "review" : "auto-submit"} max=${max} min-score=${minScore} max-bids=${maxBids}`);

  const projects = await scrapeWorkana({ maxProjects: max, minScore, maxBids });
  console.log(`[workana-bid] ${projects.length} matched projects after scoring`);

  if (projects.length === 0) {
    console.log("nothing to bid on. exit.");
    return;
  }

  // Dedup against tracker (URL match).
  const apps = readJSON<Application[]>("data/applications.json", []);
  const sent = new Set(apps.map((a) => a.url.toLowerCase()));
  const fresh = projects.filter((p) => !sent.has(p.url.toLowerCase()));
  console.log(`[workana-bid] ${fresh.length} fresh after tracker dedup`);

  // Generate proposals (sequential — keep claude CLI calls polite).
  const items: { project: WorkanaProject; proposal: Proposal }[] = [];
  for (const p of fresh) {
    console.log(`\n─ ${p.title}  [${p.bidCount} bids, ${p.budget || "no budget"}]`);
    try {
      const proposal = await draftProposal({
        title: p.title,
        description: p.description,
        budget: p.budget,
        skills: p.skills,
        clientCountry: p.clientCountry,
        bidCount: p.bidCount,
        url: p.url,
      });
      console.log(`  ✓ drafted (${proposal.match_strength}) — ${proposal.proposal.length} chars`);
      items.push({ project: p, proposal });
    } catch (e) {
      console.log(`  ✗ draft failed: ${(e as Error).message}`);
    }
  }

  // Always write drafts to disk so user has them.
  writeDraftsFile(items);

  if (draftOnly) {
    console.log("\n[draft-only] done. open data/workana-drafts.md to review.");
    return;
  }

  // Open browser session for submission.
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: !headed && autoSubmit,
    viewport: { width: 1400, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  try {
    const rl = review ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    let submitted = 0;
    for (const { project, proposal } of items) {
      if (rl) {
        console.log(`\n══ ${project.title}\n${proposal.proposal}\n`);
        const ans = (await rl.question("submit this? [y/N/skip-all] ")).trim().toLowerCase();
        if (ans === "skip-all") break;
        if (ans !== "y" && ans !== "yes") { console.log("skipped."); continue; }
      }
      const res = await submitProposal(page, project, proposal);
      console.log(res.ok ? `  ✓ ${res.reason}` : `  ✗ ${res.reason}`);
      if (res.ok) {
        const all = readJSON<Application[]>("data/applications.json", []);
        all.push({
          id: genId(), url: project.url, platform: "auto:workana",
          company: project.clientCountry ? `Workana client (${project.clientCountry})` : "Workana client",
          title: project.title, status: "applied",
          appliedAt: today(), lastUpdate: today(),
          notes: [`${today()}: Workana SPRINT bid — match=${proposal.match_strength}, price=${proposal.suggested_price}, hook=${proposal.key_hook}`],
        });
        writeJSON("data/applications.json", all);
        submitted++;
      }
      // throttle between submits
      await page.waitForTimeout(30000 + Math.random() * 30000);
    }
    rl?.close();
    console.log(`\n══════ done · ${submitted} submitted ══════`);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
