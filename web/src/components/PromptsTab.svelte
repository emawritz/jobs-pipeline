<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api.ts";

  type PromptInfo = {
    key: string;
    activeVersion: string;
    activeNotes: string;
    availableVersions: Array<{
      version: string;
      createdAt: string;
      parentVersion: string | null;
      notes: string;
      sampleSize: number | null;
      replyRate: number | null;
    }>;
  };

  type IterationListItem = {
    id: string;
    filename: string;
    createdAt: string;
    sizeBytes: number;
  };

  let prompts = $state<PromptInfo[]>([]);
  let iterations = $state<IterationListItem[]>([]);
  let openIterationBody = $state<string | null>(null);
  let openIterationId = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let toast = $state<string | null>(null);

  async function loadAll() {
    try {
      const [pRes, iRes] = await Promise.all([
        fetch("/api/prompts").then((r) => r.json()),
        fetch("/api/prompt-iterations").then((r) => r.json()),
      ]);
      prompts = pRes.prompts ?? [];
      iterations = iRes.iterations ?? [];
    } catch (e) {
      toast = `error: ${(e as Error).message}`;
    }
  }

  async function openIteration(id: string) {
    openIterationId = id;
    openIterationBody = null;
    try {
      const r = await fetch(`/api/prompt-iterations/${id}`).then((r) => r.json());
      openIterationBody = r.body ?? "(empty)";
    } catch (e) {
      openIterationBody = `error: ${(e as Error).message}`;
    }
  }

  async function activate(key: string, version: string) {
    busy = `${key}:${version}`;
    try {
      const r = await fetch("/api/prompt-activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, version }),
      }).then((r) => r.json());
      if (r.ok) {
        toast = `✓ ${key} → ${version} activated`;
        await loadAll();
      } else {
        toast = `error: ${r.error}`;
      }
    } finally {
      busy = null;
      setTimeout(() => { toast = null; }, 4000);
    }
  }

  onMount(loadAll);
</script>

<div class="prompts">
  <header>
    <h1>Prompts</h1>
    <p class="sub">
      The agent's system prompts are versioned. Use the iteration playbooks
      (Comando tab → "Iterar prompt: …") to have Claude analyze your outcomes
      and propose new versions. Nothing activates without your click.
    </p>
  </header>

  {#if toast}
    <div class="toast">{toast}</div>
  {/if}

  <section>
    <h2>Active prompts</h2>
    <table>
      <thead>
        <tr><th>Key</th><th>Active</th><th>Versions</th><th>Notes</th></tr>
      </thead>
      <tbody>
        {#each prompts as p}
          <tr>
            <td><code>{p.key}</code></td>
            <td><span class="version-pill">{p.activeVersion}</span></td>
            <td>
              {#each p.availableVersions as v}
                <button
                  class="ver"
                  class:active={v.version === p.activeVersion}
                  disabled={v.version === p.activeVersion || busy === `${p.key}:${v.version}`}
                  onclick={() => activate(p.key, v.version)}
                  title={v.notes}
                >
                  {v.version}
                  {#if v.replyRate !== null}
                    <span class="rr">{(v.replyRate * 100).toFixed(0)}%</span>
                  {/if}
                </button>
              {/each}
            </td>
            <td class="dim small">{p.activeNotes.slice(0, 100)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section>
    <h2>Iteration history</h2>
    {#if iterations.length === 0}
      <p class="dim">
        No iterations yet. Run one from the <strong>Comando</strong> tab:
        "Iterar prompt: cover-letter (EN/ES)".
      </p>
    {:else}
      <ul class="iter-list">
        {#each iterations as it}
          <li>
            <button class="iter-btn" onclick={() => openIteration(it.id)}>
              <span class="iter-id">{it.id}</span>
              <span class="iter-meta">{new Date(it.createdAt).toLocaleString()} · {(it.sizeBytes / 1024).toFixed(1)} kB</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if openIterationId}
    <section class="report">
      <header>
        <h2>{openIterationId}</h2>
        <button class="close" onclick={() => { openIterationId = null; openIterationBody = null; }}>×</button>
      </header>
      {#if openIterationBody === null}
        <p class="dim">loading…</p>
      {:else}
        <pre>{openIterationBody}</pre>
      {/if}
    </section>
  {/if}
</div>

<style>
  .prompts {
    padding: 24px 32px;
    color: var(--text, #e4e4e7);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;
  }
  header h1 {
    font-size: 28px;
    margin: 0 0 8px;
    font-weight: 700;
  }
  .sub {
    color: var(--dim, #71717a);
    font-size: 14px;
    max-width: 700px;
    line-height: 1.5;
    margin: 0 0 32px;
  }
  section {
    margin-bottom: 36px;
  }
  h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 14px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  th, td {
    padding: 12px 14px;
    text-align: left;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  th { color: var(--dim, #71717a); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  code { font-family: "JetBrains Mono", monospace; font-size: 13px; }
  .version-pill {
    background: rgba(217, 119, 87, 0.15);
    border: 1px solid rgba(217, 119, 87, 0.4);
    color: #fafafa;
    padding: 4px 10px;
    border-radius: 6px;
    font-family: "JetBrains Mono", monospace;
    font-size: 12px;
  }
  .ver {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    color: var(--text, #e4e4e7);
    padding: 6px 12px;
    border-radius: 6px;
    font-family: "JetBrains Mono", monospace;
    font-size: 12px;
    margin-right: 6px;
    cursor: pointer;
  }
  .ver:disabled { opacity: 0.5; cursor: not-allowed; }
  .ver.active { background: rgba(217, 119, 87, 0.15); border-color: rgba(217, 119, 87, 0.4); }
  .ver:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
  .rr { color: #4ade80; margin-left: 6px; font-weight: 600; }
  .dim { color: var(--dim, #71717a); }
  .small { font-size: 12px; }
  .iter-list { list-style: none; padding: 0; margin: 0; }
  .iter-list li { margin-bottom: 6px; }
  .iter-btn {
    display: flex;
    width: 100%;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 8px;
    padding: 12px 16px;
    cursor: pointer;
    align-items: center;
    gap: 16px;
    color: var(--text, #e4e4e7);
    text-align: left;
  }
  .iter-btn:hover { background: rgba(255,255,255,0.06); }
  .iter-id { font-family: "JetBrains Mono", monospace; font-size: 12px; flex: 1; }
  .iter-meta { color: var(--dim, #71717a); font-size: 12px; }
  .report {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 20px;
    margin-top: 24px;
  }
  .report header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .close {
    background: transparent;
    border: none;
    color: var(--dim, #71717a);
    font-size: 24px;
    cursor: pointer;
    padding: 0 8px;
  }
  .report pre {
    font-family: "JetBrains Mono", monospace;
    font-size: 12px;
    color: #d4d4d8;
    background: rgba(0,0,0,0.3);
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
    white-space: pre-wrap;
    line-height: 1.5;
  }
  .toast {
    position: fixed;
    bottom: 30px;
    right: 30px;
    background: rgba(217, 119, 87, 0.95);
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 1000;
    font-size: 13px;
  }
</style>
