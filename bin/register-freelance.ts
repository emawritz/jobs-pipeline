#!/usr/bin/env tsx
/**
 * register-freelance.ts
 *
 * Minimum-clicks helper to register on multiple freelance platforms.
 *
 * R1 constraint: we DO NOT automate the final Submit (platform-ban risk).
 * Per platform: open URL in default browser + copy bio content to clipboard.
 * User pastes (Cmd+V), fills any other fields, clicks Submit. Then Enter to
 * move to next platform.
 *
 * Run: npx tsx bin/register-freelance.ts   (or: npm run register-freelance)
 */
import { spawn, spawnSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const PROFILES_DIR = resolve(PROJECT_ROOT, "profiles");
const ANSWERS_PATH = resolve(PROFILES_DIR, "answers.json");
// Generic fallback bio if a platform-specific profile doesn't exist yet.
const FALLBACK_PROFILE = resolve(PROFILES_DIR, "upwork.md");

type Platform = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly profileFile: string; // absolute path
  readonly priority: string;
  readonly note: string;
};

// Order: highest ROI first (per research/freelance-platforms.md).
const PLATFORMS: readonly Platform[] = [
  {
    id: "codementor",
    name: "Codementor",
    url: "https://www.codementor.io/m/dashboard/become-mentor",
    profileFile: resolve(PROFILES_DIR, "upwork.md"), // no dedicated file — use generic
    priority: "HIGHEST",
    note: "Async, no English bar, fast cash. Apply to be a mentor. Paste bio in 'About me'.",
  },
  {
    id: "workana",
    name: "Workana (aim for Certified Devs tier)",
    url: "https://www.workana.com/signup",
    profileFile: resolve(PROFILES_DIR, "upwork.md"),
    priority: "HIGH",
    note: "Argentina-founded. After signup, request Certified Devs review for USD-paying US clients.",
  },
  {
    id: "lemon",
    name: "Lemon.io",
    url: "https://lemon.io/apply",
    profileFile: resolve(PROFILES_DIR, "lemon.md"),
    priority: "HIGH",
    note: "Vetted matching. Profile + video intro + English assessment + technical interview.",
  },
  {
    id: "revelo",
    name: "Revelo",
    url: "https://www.revelo.com/talent/sign-up",
    profileFile: resolve(PROFILES_DIR, "revelo.md"),
    priority: "MEDIUM-HIGH",
    note: "LATAM-focused. Full-time remote at US companies. Long-term contracts.",
  },
  {
    id: "arc",
    name: "Arc.dev",
    url: "https://arc.dev/talent",
    profileFile: resolve(PROFILES_DIR, "arc.md"),
    priority: "MEDIUM",
    note: "Vetted remote engineering. Profile + technical assessment.",
  },
  {
    id: "south",
    name: "South (HireInSouth)",
    url: "https://www.hireinsouth.com/apply",
    profileFile: resolve(PROFILES_DIR, "south.md"),
    priority: "MEDIUM",
    note: "LATAM staffing for US companies. Passive listing after profile.",
  },
  {
    id: "pangea",
    name: "Pangea",
    url: "https://pangea.app",
    profileFile: resolve(PROFILES_DIR, "upwork.md"),
    priority: "MEDIUM-LOW",
    note: "Click 'Apply as Talent' / signup. Hourly contract marketplace.",
  },
  {
    id: "hubstaff",
    name: "Hubstaff Talent",
    url: "https://talent.hubstaff.com/freelancers/sign_up",
    profileFile: resolve(PROFILES_DIR, "upwork.md"),
    priority: "LOW",
    note: "No vetting, passive listing. Quick setup.",
  },
] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadProfileContent(platform: Platform): Promise<string | null> {
  if (await fileExists(platform.profileFile)) {
    return readFile(platform.profileFile, "utf8");
  }
  if (await fileExists(FALLBACK_PROFILE)) {
    console.warn(
      `  ! Profile file not found for ${platform.name} (${platform.profileFile}). Falling back to upwork.md.`,
    );
    return readFile(FALLBACK_PROFILE, "utf8");
  }
  console.warn(
    `  ! No profile file and no fallback available. Skipping clipboard copy for ${platform.name}.`,
  );
  return null;
}

function copyToClipboard(text: string): boolean {
  // macOS pbcopy. Use spawnSync to wait for stdin to be consumed.
  const child = spawnSync("pbcopy", [], { input: text });
  if (child.error) {
    console.warn(`  ! pbcopy failed: ${child.error.message}`);
    return false;
  }
  if (typeof child.status === "number" && child.status !== 0) {
    console.warn(`  ! pbcopy exited with status ${child.status}`);
    return false;
  }
  return true;
}

function openUrl(url: string): boolean {
  // macOS `open` returns immediately after dispatching to LaunchServices.
  try {
    const child = spawn("open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch (err) {
    console.warn(`  ! open failed: ${(err as Error).message}`);
    return false;
  }
}

async function loadAnswers(): Promise<{ email?: string; phone?: string }> {
  try {
    const raw = await readFile(ANSWERS_PATH, "utf8");
    const json = JSON.parse(raw) as {
      identity?: { email?: string; phone?: string };
    };
    return {
      email: json.identity?.email,
      phone: json.identity?.phone,
    };
  } catch {
    return {};
  }
}

function printBanner(total: number, email?: string, phone?: string): void {
  const line = "=".repeat(72);
  console.log(line);
  console.log(`  REGISTER-FREELANCE — ${total} platforms, opened one at a time`);
  console.log(line);
  console.log(
    `Going to open ${total} tabs. For each: I'll copy the profile to clipboard +`,
  );
  console.log(`open the URL. You fill the form, paste profile in the bio field`);
  console.log(`(Cmd+V), click Submit. Press Enter to advance to next platform.`);
  console.log("");
  console.log(`Reusable values (copy from here as needed):`);
  console.log(`  Email: ${email ?? "your@email.com"}`);
  console.log(`  Phone: ${phone ?? "(see profiles/answers.json)"}`);
  console.log(`  CV:    ${resolve(PROJECT_ROOT, "cv/cv.pdf")}`);
  console.log("");
  console.log(`Constraint: I will NOT click Submit for you (platform-ban risk).`);
  console.log(line);
  console.log("");
}

function printPlatformHeader(idx: number, total: number, p: Platform): void {
  console.log("");
  console.log(`[${idx + 1}/${total}] ${p.name}  —  priority: ${p.priority}`);
  console.log(`  URL:     ${p.url}`);
  console.log(`  Profile: ${p.profileFile.replace(PROJECT_ROOT + "/", "")}`);
  console.log(`  Action:  ${p.note}`);
}

async function main(): Promise<void> {
  const answers = await loadAnswers();
  printBanner(PLATFORMS.length, answers.email, answers.phone);

  const rl = createInterface({ input, output });

  try {
    await rl.question("Press Enter to start with the first platform... ");

    for (let i = 0; i < PLATFORMS.length; i++) {
      const p = PLATFORMS[i];
      printPlatformHeader(i, PLATFORMS.length, p);

      const content = await loadProfileContent(p);
      if (content) {
        const ok = copyToClipboard(content);
        if (ok) {
          console.log(
            `  > Copied ${content.length} chars to clipboard. Paste with Cmd+V.`,
          );
        }
      }

      const opened = openUrl(p.url);
      if (opened) {
        console.log(`  > Opened ${p.url} in default browser.`);
      }

      console.log(
        `  > Now: complete the form in the browser, paste bio, click Submit.`,
      );

      const isLast = i === PLATFORMS.length - 1;
      const prompt = isLast
        ? "  Press Enter when you've finished this last platform... "
        : "  Press Enter to continue to the next platform... ";
      await rl.question(prompt);
    }

    const line = "=".repeat(72);
    console.log("");
    console.log(line);
    console.log(
      `  ALL ${PLATFORMS.length} OPENED. Now manually complete each registration form.`,
    );
    console.log(line);
    console.log("");
    console.log("Next steps:");
    console.log("  - Check email for confirmation links from each platform.");
    console.log("  - Upload CV (cv/cv.pdf) where requested.");
    console.log("  - For Lemon/Arc/Revelo: schedule the technical interview.");
    console.log("  - Track status in your job pipeline (npm run tracker).");
    console.log("");
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
