<script lang="ts">
  import { api, streamJob, type Playbook, type Job, type Status } from "../lib/api.ts";
  import { onDestroy } from "svelte";

  let { notify }: { notify: (m: string) => void } = $props();

  let playbooks = $state<Playbook[]>([]);
  let status = $state<Status | null>(null);
  let jobs = $state<Job[]>([]);
  let activeJob = $state<Job | null>(null);
  let liveLines = $state<string[]>([]);
  let confirmId = $state<string | null>(null);  // playbook waiting for confirm
  let unsubStream: (() => void) | null = null;
  let statusPoll: ReturnType<typeof setInterval> | null = null;
  let jobsPoll: ReturnType<typeof setInterval> | null = null;

  // Orden de grupos. Cada uno con sus playbook ids.
  const GROUPS: { key: string; title: string; subtitle: string; ids: string[] }[] = [
    {
      key: "email", title: "📧 Email a fundadores",
      subtitle: "Mandar emails personalizados a fundadores reales (no job boards)",
      ids: ["email-spain-sprint-dry", "email-spain-sprint"],
    },
    {
      key: "workana", title: "💼 Workana (freelance LATAM)",
      subtitle: "Escanear proyectos y generar propuestas. Requiere perfil aprobado.",
      ids: ["workana-scan", "workana-drafts"],
    },
    {
      key: "web", title: "🤖 Auto-aplicación a empleos",
      subtitle: "Promueve URLs a emails y manda aplicación con CV adjunto",
      ids: ["auto-apply-email", "getonboard-apply-dry", "getonboard-apply"],
    },
    {
      key: "digest", title: "🔍 Buscar empleos nuevos",
      subtitle: "Scrapea 16 fuentes y scorea con Claude Haiku",
      ids: ["digest-50", "digest-200"],
    },
    {
      key: "hn", title: "📰 HN poster",
      subtitle: "El poster automático fires el 1 de cada mes — acá podés ver el thread",
      ids: ["hn-check"],
    },
    {
      key: "maintenance", title: "⚙️  Mantenimiento",
      subtitle: "Tareas operativas (followups, registrarse en plataformas, etc.)",
      ids: ["daily-run", "followup", "register-freelance"],
    },
  ];

  async function loadAll() {
    [playbooks, status, jobs] = await Promise.all([
      api.playbooks(),
      api.status(),
      api.jobs(),
    ]);
  }

  loadAll();
  statusPoll = setInterval(async () => { status = await api.status(); }, 5000);
  jobsPoll = setInterval(async () => { jobs = await api.jobs(); }, 4000);

  onDestroy(() => {
    if (statusPoll) clearInterval(statusPoll);
    if (jobsPoll) clearInterval(jobsPoll);
    if (unsubStream) unsubStream();
  });

  function findPlaybook(id: string): Playbook | undefined {
    return playbooks.find((p) => p.id === id);
  }

  function detachStream() {
    if (unsubStream) { unsubStream(); unsubStream = null; }
  }

  function attachStream(job: Job) {
    detachStream();
    activeJob = job;
    liveLines = [...job.output];
    if (job.status === "running") {
      unsubStream = streamJob(
        job.id,
        (line) => { liveLines = [...liveLines, line]; },
        async (info) => {
          const statusEs = info.status === "completed" ? "OK"
            : info.status === "failed" ? "falló"
            : info.status === "killed" ? "detenida"
            : info.status;
          notify(`${job.label} → ${statusEs}`);
          jobs = await api.jobs();
          status = await api.status();
        },
      );
    }
  }

  async function runPlaybook(id: string) {
    const p = findPlaybook(id);
    if (!p) return;
    confirmId = null;
    notify(`▶ ${p.label}`);
    const job = await api.run(id);
    jobs = [job, ...jobs];
    attachStream(job);
  }

  function clickPlaybook(id: string) {
    const p = findPlaybook(id);
    if (!p) return;
    if (p.danger) {
      // Two-step: first click sets confirm, second click within 6s runs.
      if (confirmId === id) {
        runPlaybook(id);
      } else {
        confirmId = id;
        setTimeout(() => { if (confirmId === id) confirmId = null; }, 6000);
      }
    } else {
      runPlaybook(id);
    }
  }

  async function viewJob(id: string) {
    const j = await api.job(id);
    attachStream(j);
  }

  async function stopActive() {
    if (!activeJob) return;
    if (activeJob.status !== "running") return;
    const r = await api.stopJob(activeJob.id);
    notify(r.ok ? "tarea detenida" : `error al detener: ${r.reason}`);
    jobs = await api.jobs();
  }

  function clearLog() {
    liveLines = [];
    detachStream();
    activeJob = null;
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

  function fmtDuration(j: Job): string {
    if (!j.endedAt) return j.status === "running" ? "corriendo…" : "?";
    const ms = new Date(j.endedAt).getTime() - new Date(j.startedAt).getTime();
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)} min ${Math.floor((ms % 60000) / 1000)} s`;
  }

  function statusEs(s: string): string {
    return s === "running" ? "corriendo"
      : s === "completed" ? "OK"
      : s === "failed" ? "falló"
      : s === "killed" ? "detenida"
      : s;
  }
</script>

<div class="comando">
  <!-- ── PILLS DE ESTADO ─────────────────────────────────────────────── -->
  {#if status}
    <section class="pills">
      <div class="pill">
        <span class="pill-label">apps enviadas</span>
        <span class="pill-val">{status.applications.total}</span>
        <span class="pill-sub">+{status.applications.last24h} en 24h · +{status.applications.last7d} en 7d</span>
      </div>
      <div class="pill">
        <span class="pill-label">respuestas</span>
        <span class="pill-val" class:hot={(status.applications.byStatus.replied ?? 0) > 0}>
          {status.applications.byStatus.replied ?? 0}
        </span>
        <span class="pill-sub">de {status.applications.byStatus.applied ?? 0} esperando</span>
      </div>
      <div class="pill">
        <span class="pill-label">emails</span>
        <span class="pill-val">{status.channels.email.sentTotal}</span>
        <span class="pill-sub">+{status.channels.email.sent24h} en 24h</span>
      </div>
      <div class="pill">
        <span class="pill-label">workana</span>
        <span class="pill-val">{status.channels.workana.sentTotal}</span>
        <span class="pill-sub">{status.channels.workana.profileNote}</span>
      </div>
      <div class="pill">
        <span class="pill-label">linkedin</span>
        <span class="pill-val">{status.outreach.sent}/{status.outreach.total}</span>
        <span class="pill-sub">{status.outreach.pending} pendientes</span>
      </div>
      <div class="pill">
        <span class="pill-label">último digest</span>
        <span class="pill-val">{status.scrapers.lastDigestCount ?? "—"}</span>
        <span class="pill-sub">{fmtTime(status.scrapers.lastDigestAt)}</span>
      </div>
      <div class="pill">
        <span class="pill-label">cron diario 8am</span>
        <span class="pill-val" class:dim={!status.cron.daily.plistInstalled}>
          {status.cron.daily.plistInstalled ? "activo" : "apagado"}
        </span>
        <span class="pill-sub">último: {fmtTime(status.cron.daily.lastRunAt)}</span>
      </div>
      <div class="pill">
        <span class="pill-label">HN poster (1/mes)</span>
        <span class="pill-val" class:dim={!status.cron.hnPoster.plistInstalled}>
          {status.cron.hnPoster.plistInstalled ? "activo" : "apagado"}
        </span>
        <span class="pill-sub">{status.cron.hnPoster.plistInstalled ? "fires el 1 de cada mes" : "pausado"}</span>
      </div>
      <div class="pill">
        <span class="pill-label">pipeline España</span>
        <span class="pill-val">{status.pipelines.spainTargetsCount}</span>
        <span class="pill-sub">{status.pipelines.spainTargetsExist ? "fundadores listos" : "sin datos"}</span>
      </div>
    </section>
  {/if}

  <!-- ── CARDS DE ACCIÓN ─────────────────────────────────────────────── -->
  <section class="grid">
    {#each GROUPS as g}
      <div class="card">
        <h3>{g.title}</h3>
        <p class="card-sub">{g.subtitle}</p>
        <div class="actions">
          {#each g.ids as id}
            {@const pb = findPlaybook(id)}
            {#if pb}
              <button
                class="action"
                class:danger={pb.danger}
                class:confirming={confirmId === id}
                onclick={() => clickPlaybook(id)}
                title={pb.command}
              >
                <div class="action-row">
                  <span class="action-label">{pb.label}</span>
                  {#if pb.danger}<span class="badge">envía</span>{/if}
                </div>
                <span class="action-desc">{pb.description}</span>
                {#if confirmId === id}
                  <span class="action-confirm">⚠ Clickeá de nuevo en 6 seg para confirmar</span>
                {/if}
              </button>
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  </section>

  <!-- ── LOG EN VIVO ─────────────────────────────────────────────────── -->
  <section class="log">
    <div class="log-head">
      <div>
        <strong>{activeJob ? activeJob.label : "Salida en vivo"}</strong>
        {#if activeJob}
          <span class="dim">· {statusEs(activeJob.status)} · {fmtDuration(activeJob)}</span>
        {/if}
      </div>
      <div class="log-actions">
        {#if activeJob?.status === "running"}
          <button onclick={stopActive}>detener</button>
        {/if}
        <button onclick={clearLog}>limpiar</button>
      </div>
    </div>
    <div class="log-body mono">
      {#each liveLines as line}
        <div class="log-line" class:err={line.startsWith("stderr:")}>{line}</div>
      {:else}
        <div class="dim">Hacé click en cualquier acción de arriba — el output aparece acá en vivo.</div>
      {/each}
    </div>
  </section>

  <!-- ── HISTORIAL ──────────────────────────────────────────────────── -->
  <section class="history">
    <h3>Historial de ejecuciones</h3>
    {#if jobs.length === 0}
      <div class="dim">Todavía no corriste nada.</div>
    {:else}
      <table class="history-table">
        <thead>
          <tr>
            <th>tarea</th>
            <th>estado</th>
            <th>iniciado</th>
            <th>duración</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each jobs.slice(0, 20) as j}
            <tr class:row-running={j.status === "running"}>
              <td>{j.label}</td>
              <td class:status-ok={j.status === "completed"}
                  class:status-err={j.status === "failed" || j.status === "killed"}
                  class:status-run={j.status === "running"}>
                {statusEs(j.status)}{j.exitCode != null ? ` (${j.exitCode})` : ""}
              </td>
              <td class="mono dim">{fmtTime(j.startedAt)}</td>
              <td class="mono dim">{fmtDuration(j)}</td>
              <td>
                <button class="link" onclick={() => viewJob(j.id)}>ver log ↑</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</div>

<style>
  .comando {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* pills de estado */
  .pills {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
  }
  .pill {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    background: var(--surface, #1a1a1a);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 6px;
  }
  .pill-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--dim, #888);
  }
  .pill-val {
    font-size: 22px;
    font-weight: 600;
    line-height: 1;
  }
  .pill-val.dim {
    color: var(--dim, #888);
  }
  .pill-val.hot {
    color: #ffb84a;
  }
  .pill-sub {
    font-size: 10px;
    color: var(--dim, #888);
  }

  /* grilla de acciones */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
  }
  .card {
    background: var(--surface, #1a1a1a);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 6px;
    padding: 14px;
  }
  .card h3 {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 600;
  }
  .card-sub {
    margin: 0 0 12px;
    font-size: 11px;
    color: var(--dim, #888);
    line-height: 1.4;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .action {
    text-align: left;
    padding: 10px 12px;
    background: transparent;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    transition: all 0.1s;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .action:hover {
    background: var(--hover, #222);
    border-color: var(--accent, #4a90e2);
  }
  .action.danger {
    border-color: rgba(255, 138, 76, 0.35);
  }
  .action.danger:hover {
    background: rgba(255, 138, 76, 0.08);
    border-color: #ff8a4c;
  }
  .action.confirming {
    background: rgba(255, 138, 76, 0.15);
    border-color: #ff8a4c;
  }
  .action-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .action-label {
    font-size: 13px;
    font-weight: 500;
  }
  .badge {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    background: rgba(255, 138, 76, 0.2);
    color: #ff8a4c;
    border-radius: 3px;
    font-weight: 600;
  }
  .action-desc {
    font-size: 11px;
    color: var(--dim, #888);
    line-height: 1.4;
  }
  .action-confirm {
    font-size: 11px;
    color: #ff8a4c;
    font-weight: 600;
    margin-top: 2px;
  }

  /* log en vivo */
  .log {
    background: var(--surface, #0d0d0d);
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 6px;
    overflow: hidden;
  }
  .log-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: var(--surface-2, #181818);
    border-bottom: 1px solid var(--border, #2a2a2a);
    font-size: 12px;
  }
  .log-actions {
    display: flex;
    gap: 6px;
  }
  .log-body {
    padding: 10px 14px;
    max-height: 320px;
    overflow-y: auto;
    font-size: 11px;
    line-height: 1.5;
  }
  .log-line {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .log-line.err {
    color: #ff7878;
  }

  /* historial */
  .history h3 {
    margin: 8px 0;
    font-size: 14px;
    font-weight: 600;
  }
  .history-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .history-table th {
    text-align: left;
    padding: 7px 9px;
    color: var(--dim, #888);
    font-weight: 500;
    border-bottom: 1px solid var(--border, #2a2a2a);
  }
  .history-table td {
    padding: 7px 9px;
    border-bottom: 1px solid var(--border, #1a1a1a);
  }
  .row-running {
    background: rgba(74, 144, 226, 0.05);
  }
  .status-ok { color: #6cce6c; }
  .status-err { color: #ff7878; }
  .status-run { color: #4a90e2; }
  .link {
    background: transparent;
    border: none;
    color: var(--accent, #4a90e2);
    cursor: pointer;
    font-size: 11px;
    padding: 0;
  }
  .link:hover { text-decoration: underline; }

  .mono { font-family: ui-monospace, monospace; }
  .dim { color: var(--dim, #888); }
</style>
