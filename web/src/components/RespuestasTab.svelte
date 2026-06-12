<script lang="ts">
  import { sistemaApi, api, type EnrichedReply, type GmailStatus } from "../lib/api.ts";
  import { onDestroy } from "svelte";

  let { notify }: { notify: (m: string) => void } = $props();

  let replies = $state<EnrichedReply[]>([]);
  let gmailStatus = $state<GmailStatus | null>(null);
  let loading = $state(true);
  let expanded = $state<Set<string>>(new Set());
  let poll: ReturnType<typeof setInterval> | null = null;

  async function load() {
    loading = true;
    try {
      [replies, gmailStatus] = await Promise.all([
        sistemaApi.replies(),
        sistemaApi.gmailStatus(),
      ]);
    } catch (e) {
      notify(`error: ${(e as Error).message}`);
    } finally {
      loading = false;
    }
  }

  load();
  poll = setInterval(load, 15000);
  onDestroy(() => { if (poll) clearInterval(poll); });

  function toggle(id: string) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    expanded = new Set(expanded);
  }

  async function runPoll() {
    notify("Sincronizando con Gmail…");
    const job = await api.run("gmail-poll");
    notify(`▶ ${job.label}`);
  }

  async function markStatus(reply: EnrichedReply, status: string) {
    if (!reply.app) return;
    await api.updateApplication(reply.app.id, { status });
    notify(`${reply.app.company ?? reply.fromEmail} → ${status}`);
    await load();
  }

  async function copyReplyForResponse(reply: EnrichedReply) {
    const text = `Reply from: ${reply.fromDisplay}
Subject: ${reply.subject}
Date: ${reply.date}

${reply.body}`;
    await api.clipboard(text);
    notify(`reply de ${reply.fromEmail} copiado — pegalo en \`npm run reply -- ${reply.appId} --from-clipboard\``);
  }

  function fmtDate(s: string): string {
    if (!s) return "—";
    try {
      const d = new Date(s);
      return d.toLocaleString("es-AR", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return s; }
  }

  function fmtAgo(iso?: string | null): string {
    if (!iso) return "nunca";
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return "recién";
    if (ms < 3600000) return `hace ${Math.floor(ms / 60000)} min`;
    if (ms < 86400000) return `hace ${Math.floor(ms / 3600000)} h`;
    return `hace ${Math.floor(ms / 86400000)} días`;
  }
</script>

<div class="resp">

  <!-- ── ESTADO GMAIL ────────────────────────────────────────────── -->
  <section class="status-block">
    <div class="status-row">
      <div>
        <strong>Conexión Gmail</strong>
        {#if gmailStatus}
          {#if gmailStatus.credentialsConfigured && gmailStatus.tokenConfigured}
            <span class="pill on">conectado</span>
            <span class="dim small">
              último poll: {fmtAgo(gmailStatus.lastPollAt)} ·
              {gmailStatus.repliesDetected} respuestas detectadas
            </span>
          {:else if gmailStatus.credentialsConfigured}
            <span class="pill warn">credentials.json OK, falta token</span>
            <span class="dim small">corré: <code class="mono">npm run gmail-auth</code></span>
          {:else}
            <span class="pill off">no configurado</span>
            <span class="dim small">seguí los pasos de <code class="mono">data/gmail/SETUP.md</code></span>
          {/if}
        {:else}
          <span class="dim">cargando…</span>
        {/if}
      </div>
      <div class="row gap-sm">
        <button onclick={runPoll} disabled={!gmailStatus?.tokenConfigured}>
          sincronizar ahora
        </button>
        <button onclick={load}>refrescar</button>
      </div>
    </div>
  </section>

  <!-- ── LISTA DE RESPUESTAS ────────────────────────────────────────── -->
  {#if loading}
    <div class="empty">cargando respuestas…</div>
  {:else if replies.length === 0}
    <div class="empty">
      {#if !gmailStatus?.tokenConfigured}
        Una vez configurado Gmail OAuth, las respuestas a tus emails van a aparecer acá automáticamente.
      {:else}
        No hay respuestas todavía. Probá <strong>sincronizar ahora</strong>.
      {/if}
    </div>
  {:else}
    <div class="counts">
      <strong>{replies.length}</strong> respuestas detectadas
      · <span class="dim">{new Set(replies.map((r) => r.fromEmail)).size} remitentes únicos</span>
    </div>

    {#each replies as r (r.id)}
      <div class="card">
        <div class="card-head">
          <div class="card-meta">
            <strong>{r.fromDisplay}</strong>
            <span class="dim small">→ {r.app?.company ?? "(app desconocida)"}</span>
            <span class="dim small">· {fmtDate(r.date)}</span>
          </div>
          <div class="row gap-sm">
            <button onclick={() => toggle(r.id)}>
              {expanded.has(r.id) ? "ocultar" : "ver completo"}
            </button>
            <button onclick={() => copyReplyForResponse(r)}>copiar para responder</button>
            {#if r.app}
              <button onclick={() => markStatus(r, "interviewing")}>en entrevista</button>
              <button onclick={() => markStatus(r, "offer")}>oferta!</button>
              <button onclick={() => markStatus(r, "rejected")}>rechazado</button>
            {/if}
          </div>
        </div>
        <div class="subject"><em>Asunto:</em> {r.subject}</div>
        <div class="snippet">{r.snippet}</div>
        {#if r.app}
          <div class="app-context">
            <span class="dim small">
              app <code class="mono">{r.app.id}</code> · estado: <strong>{r.app.status}</strong> ·
              enviado {r.app.appliedAt} · canal: {r.app.platform}
            </span>
          </div>
        {/if}

        {#if expanded.has(r.id)}
          <div class="full-body">
            <div class="body-head">Cuerpo del email</div>
            <pre class="body-text">{r.body}</pre>
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .resp {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .status-block {
    background: var(--surface, #1a1a1a);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 6px;
    padding: 12px 14px;
  }
  .status-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .status-row > div:first-child {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .pill {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 3px;
    font-weight: 600;
  }
  .pill.on { background: rgba(108, 206, 108, 0.15); color: #6cce6c; }
  .pill.warn { background: rgba(255, 184, 74, 0.15); color: #ffb84a; }
  .pill.off { background: rgba(255, 120, 120, 0.10); color: #ff7878; }

  .counts {
    color: var(--dim, #aaa);
    font-size: 13px;
  }
  .counts strong {
    color: inherit;
    font-size: 16px;
    margin-right: 4px;
  }

  .empty {
    background: var(--surface, #1a1a1a);
    border: 1px dashed var(--border, #2a2a2a);
    padding: 20px;
    border-radius: 6px;
    color: var(--dim, #aaa);
    text-align: center;
  }

  .card {
    background: var(--surface, #1a1a1a);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 6px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .card-meta {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .subject {
    font-size: 12px;
    color: var(--dim, #aaa);
  }
  .snippet {
    font-size: 13px;
    color: #ccc;
    line-height: 1.5;
  }
  .app-context {
    margin-top: 4px;
  }
  .full-body {
    margin-top: 10px;
    background: var(--surface-2, #0d0d0d);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 4px;
  }
  .body-head {
    padding: 6px 12px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--dim, #888);
    border-bottom: 1px solid var(--border, #2a2a2a);
  }
  .body-text {
    padding: 10px 12px;
    margin: 0;
    max-height: 380px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.55;
  }

  .small { font-size: 11px; }
  .mono { font-family: ui-monospace, monospace; }
  .dim { color: var(--dim, #888); }
</style>
