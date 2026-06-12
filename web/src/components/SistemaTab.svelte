<script lang="ts">
  import { sistemaApi, type Funnel, type CronEntry, type TargetFile } from "../lib/api.ts";
  import { onDestroy } from "svelte";

  let { notify }: { notify: (m: string) => void } = $props();

  let funnel = $state<Funnel | null>(null);
  let cron = $state<CronEntry[]>([]);
  let targetsFiles = $state<TargetFile[]>([]);
  let openedFile = $state<{ path: string; content: string } | null>(null);
  let openedLog = $state<{ path: string; content: string } | null>(null);
  let poll: ReturnType<typeof setInterval> | null = null;

  async function loadAll() {
    [funnel, cron, targetsFiles] = await Promise.all([
      sistemaApi.funnel(),
      sistemaApi.cronList(),
      sistemaApi.targetsList(),
    ]);
  }

  loadAll();
  poll = setInterval(loadAll, 10000);
  onDestroy(() => { if (poll) clearInterval(poll); });

  async function toggleCron(c: CronEntry) {
    const wantText = c.installed ? "DESACTIVAR" : "ACTIVAR";
    if (!confirm(`¿${wantText} el cron ${c.label}?`)) return;
    const r = await sistemaApi.cronToggle(c.filename);
    notify(r.ok ? `${c.label} → ${r.reason}` : `error: ${r.reason}`);
    await loadAll();
  }

  async function viewLog(c: CronEntry) {
    if (!c.logFile) {
      notify("este cron no tiene log configurado");
      return;
    }
    const r = await sistemaApi.cronLog(c.logFile, 80);
    openedLog = { path: c.logFile, content: r.content };
  }

  async function viewFile(t: TargetFile) {
    if (!t.exists) {
      notify("el archivo no existe todavía");
      return;
    }
    const r = await sistemaApi.targetsRead(t.path);
    if (!r.ok) {
      notify(`error: ${r.reason}`);
      return;
    }
    openedFile = { path: t.path, content: r.content ?? "" };
  }

  function fmtTime(iso?: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return "recién";
    if (diff < 3600000) return `hace ${Math.floor(diff / 60000)} min`;
    if (diff < 86400000) return `hace ${Math.floor(diff / 3600000)} h`;
    return d.toISOString().slice(5, 16).replace("T", " ");
  }

  // Funnel viz — calculate bar widths relative to max stage count.
  let maxCount = $derived(funnel ? Math.max(1, ...funnel.stages.map((s) => s.count)) : 1);

  function barWidth(n: number): string {
    return `${Math.max(5, (n / maxCount) * 100)}%`;
  }
</script>

<div class="sistema">

  <!-- ── SECCIÓN 1 · PIPELINE FUNNEL ────────────────────────────────── -->
  <section class="block">
    <h2>Embudo de conversión</h2>
    <p class="dim sub">Cada etapa muestra cuántos pasaron + qué porcentaje vs la etapa anterior. Las conversiones se calculan sobre datos REALES de tu pipeline.</p>

    {#if funnel}
      <div class="funnel">
        {#each funnel.stages as s, i}
          <div class="stage">
            <div class="stage-head">
              <span class="stage-label">{s.label}</span>
              <span class="stage-count">{s.count.toLocaleString()}</span>
              {#if s.convPct != null}
                <span class="stage-conv" class:hot={s.convPct >= 10} class:warm={s.convPct >= 1 && s.convPct < 10} class:cold={s.convPct < 1}>
                  {s.convPct}% vs anterior
                </span>
              {/if}
            </div>
            {#if s.detail}
              <div class="stage-detail">{s.detail}</div>
            {/if}
            <div class="stage-bar-wrap">
              <div class="stage-bar" style="width: {barWidth(s.count)}"></div>
            </div>
          </div>
        {/each}
      </div>

      <h3 class="block-h3">Por canal</h3>
      <table class="channel-table">
        <thead>
          <tr>
            <th>canal</th>
            <th class="num">enviadas</th>
            <th class="num">respuestas</th>
            <th class="num">conversión</th>
          </tr>
        </thead>
        <tbody>
          {#each funnel.byChannel as c}
            <tr>
              <td>{c.channel}</td>
              <td class="num mono">{c.sent}</td>
              <td class="num mono" class:hot={c.replied > 0}>{c.replied}</td>
              <td class="num mono" class:hot={c.convPct >= 10} class:warm={c.convPct >= 1 && c.convPct < 10}>{c.convPct}%</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <div class="dim">cargando embudo…</div>
    {/if}
  </section>

  <!-- ── SECCIÓN 2 · CRON MANAGER ───────────────────────────────────── -->
  <section class="block">
    <h2>Tareas programadas (cron)</h2>
    <p class="dim sub">launchd jobs en ~/Library/LaunchAgents/. Toggleá para activar/desactivar.</p>

    {#if cron.length === 0}
      <div class="dim">no hay plists configurados todavía</div>
    {:else}
      <table class="cron-table">
        <thead>
          <tr>
            <th>nombre</th>
            <th>horario</th>
            <th>estado</th>
            <th>último exit</th>
            <th>log</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each cron as c}
            <tr>
              <td>
                <strong>{c.label.replace("dev.jobs-pipeline.", "")}</strong>
                {#if c.scriptPath}
                  <div class="dim mono small">{c.scriptPath.split("/").slice(-2).join("/")}</div>
                {/if}
              </td>
              <td class="dim">{c.schedule}</td>
              <td>
                {#if c.installed && c.loaded}
                  <span class="pill-state on">activo</span>
                {:else if c.installed}
                  <span class="pill-state warn">instalado pero no cargado</span>
                {:else}
                  <span class="pill-state off">apagado</span>
                {/if}
                {#if c.pid}
                  <span class="dim mono small">pid {c.pid}</span>
                {/if}
              </td>
              <td class="mono dim">
                {c.lastExitCode == null ? "—" : c.lastExitCode === 0 ? "OK" : `falló (${c.lastExitCode})`}
              </td>
              <td>
                {#if c.logFile}
                  <button class="link" onclick={() => viewLog(c)}>{c.logTailKb} kb ↓</button>
                {:else}
                  <span class="dim small">—</span>
                {/if}
              </td>
              <td>
                <button onclick={() => toggleCron(c)}>{c.installed ? "desactivar" : "activar"}</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if openedLog}
      <div class="viewer">
        <div class="viewer-head">
          <strong>{openedLog.path}</strong>
          <button onclick={() => (openedLog = null)}>cerrar ✕</button>
        </div>
        <pre class="viewer-body">{openedLog.content}</pre>
      </div>
    {/if}
  </section>

  <!-- ── SECCIÓN 3 · ARCHIVOS DE TARGETS ────────────────────────────── -->
  <section class="block">
    <h2>Archivos de targets</h2>
    <p class="dim sub">Listas de personas/empresas a contactar. Read-only desde acá. Para editarlos abrí el path en tu IDE.</p>

    <div class="files-grid">
      {#each targetsFiles as t}
        <div class="file-card" class:missing={!t.exists}>
          <div class="file-head">
            <strong>{t.label}</strong>
            {#if t.count != null}
              <span class="badge num">{t.count}</span>
            {/if}
          </div>
          <div class="dim small mono">{t.path}</div>
          {#if t.exists}
            <div class="file-meta">
              <span class="dim small">{t.sizeKb} kb · {fmtTime(t.mtime)}</span>
              <button class="link" onclick={() => viewFile(t)}>ver contenido ↓</button>
            </div>
          {:else}
            <div class="dim small">(no existe todavía)</div>
          {/if}
        </div>
      {/each}
    </div>

    {#if openedFile}
      <div class="viewer">
        <div class="viewer-head">
          <strong>{openedFile.path}</strong>
          <button onclick={() => (openedFile = null)}>cerrar ✕</button>
        </div>
        <pre class="viewer-body">{openedFile.content}</pre>
      </div>
    {/if}
  </section>
</div>

<style>
  .sistema {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .block {
    background: var(--surface, #1a1a1a);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 6px;
    padding: 16px 18px;
  }
  .block h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
  }
  .block-h3 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--dim, #aaa);
    margin: 18px 0 6px;
  }
  .sub {
    font-size: 12px;
    margin: 0 0 14px;
  }

  /* funnel */
  .funnel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .stage {
    background: var(--surface-2, #0f0f0f);
    padding: 10px 12px;
    border-radius: 5px;
    border: 1px solid var(--border, #222);
  }
  .stage-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 3px;
  }
  .stage-label {
    font-weight: 500;
    font-size: 13px;
  }
  .stage-count {
    font-family: ui-monospace, monospace;
    font-size: 18px;
    font-weight: 600;
    color: #6cce6c;
  }
  .stage-conv {
    margin-left: auto;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .stage-conv.hot { background: rgba(108, 206, 108, 0.15); color: #6cce6c; }
  .stage-conv.warm { background: rgba(255, 184, 74, 0.15); color: #ffb84a; }
  .stage-conv.cold { background: rgba(255, 120, 120, 0.10); color: #ff7878; }
  .stage-detail {
    font-size: 11px;
    color: var(--dim, #888);
    margin-bottom: 5px;
  }
  .stage-bar-wrap {
    background: var(--border, #222);
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
  }
  .stage-bar {
    height: 100%;
    background: linear-gradient(90deg, #4a90e2, #6cce6c);
  }

  /* tables */
  .channel-table, .cron-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    text-align: left;
    padding: 7px 9px;
    color: var(--dim, #888);
    font-weight: 500;
    border-bottom: 1px solid var(--border, #2a2a2a);
  }
  td {
    padding: 7px 9px;
    border-bottom: 1px solid var(--border, #1a1a1a);
  }
  th.num, td.num {
    text-align: right;
  }
  td.hot { color: #6cce6c; font-weight: 600; }
  td.warm { color: #ffb84a; font-weight: 600; }

  /* cron state pills */
  .pill-state {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 600;
  }
  .pill-state.on { background: rgba(108, 206, 108, 0.15); color: #6cce6c; }
  .pill-state.warn { background: rgba(255, 184, 74, 0.15); color: #ffb84a; }
  .pill-state.off { background: rgba(136, 136, 136, 0.15); color: #888; }

  /* files grid */
  .files-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 10px;
  }
  .file-card {
    background: var(--surface-2, #0f0f0f);
    border: 1px solid var(--border, #222);
    border-radius: 5px;
    padding: 10px 12px;
  }
  .file-card.missing {
    opacity: 0.5;
  }
  .file-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 3px;
  }
  .badge.num {
    background: var(--border, #222);
    color: #6cce6c;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 3px;
  }
  .file-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 6px;
  }

  /* viewer */
  .viewer {
    margin-top: 14px;
    background: var(--surface-2, #0d0d0d);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 5px;
    overflow: hidden;
  }
  .viewer-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: var(--surface, #181818);
    border-bottom: 1px solid var(--border, #2a2a2a);
    font-size: 12px;
  }
  .viewer-body {
    padding: 10px 14px;
    margin: 0;
    max-height: 420px;
    overflow: auto;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, monospace;
  }

  .link {
    background: transparent;
    border: none;
    color: var(--accent, #4a90e2);
    cursor: pointer;
    font-size: 11px;
    padding: 0;
  }
  .link:hover { text-decoration: underline; }
  .small { font-size: 10px; }
  .mono { font-family: ui-monospace, monospace; }
  .dim { color: var(--dim, #888); }
</style>
