<script lang="ts">
  import { api, type OutreachTarget } from "../lib/api.ts";

  let { notify, count = $bindable() }: { notify: (m: string) => void; count: number } = $props();

  let targets = $state<OutreachTarget[]>([]);
  let loading = $state(true);
  let expanded = $state<Set<number>>(new Set());
  let filter = $state<"all" | "pending" | "sent">("all");

  async function load() {
    loading = true;
    targets = await api.outreach();
    count = targets.length;
    loading = false;
  }

  load();

  function toggle(n: number) {
    if (expanded.has(n)) expanded.delete(n);
    else expanded.add(n);
    expanded = new Set(expanded);
  }

  let filtered = $derived(
    targets.filter((t) => filter === "all" || (filter === "sent" ? t.sent : !t.sent)),
  );
  let pendingCount = $derived(targets.filter((t) => !t.sent).length);
  let sentCount = $derived(targets.filter((t) => t.sent).length);

  async function copyAndOpen(t: OutreachTarget) {
    if (!t.message) {
      notify(`no hay mensaje para ${t.name} — correr bin/batch-outreach.ts`);
      return;
    }
    await api.clipboard(t.message);
    // Abre LinkedIn directo si tenemos URL, sino abre búsqueda con el nombre.
    const target = t.linkedin ?? t.linkedinSearch;
    await api.open(target);
    notify(`copiado · ${t.linkedin ? "LinkedIn abierto" : "búsqueda abierta"} para ${t.name}`);
  }

  async function searchOnly(t: OutreachTarget) {
    if (t.message) await api.clipboard(t.message);
    await api.open(t.linkedinSearch);
    notify(`búsqueda abierta para ${t.founderName ?? t.name}`);
  }

  async function markSent(t: OutreachTarget) {
    const app = await api.addApplication({
      url: t.linkedin ?? t.site ?? `https://example.com/${t.num}`,
      platform: "outreach-linkedin",
      company: t.name,
      title: "cold outreach",
    });
    notify(`marcado como enviado · ${app.id} · ${t.name}`);
    await load();
  }
</script>

{#if loading}
  <div class="empty">cargando contactos…</div>
{:else if targets.length === 0}
  <div class="empty">no hay contactos — correr research agent + bin/batch-outreach.ts</div>
{:else}
  <div class="row between" style="margin-bottom: 12px">
    <div class="dim">
      {targets.length} contactos ·
      <span style="color: var(--warn)">{pendingCount} pendientes</span> ·
      <span style="color: var(--good)">{sentCount} enviados</span>
    </div>
    <div class="row gap-sm">
      <button class:active={filter === "all"} onclick={() => (filter = "all")}>todos</button>
      <button class:active={filter === "pending"} onclick={() => (filter = "pending")}>pendientes</button>
      <button class:active={filter === "sent"} onclick={() => (filter = "sent")}>enviados</button>
      <button onclick={load}>refrescar</button>
    </div>
  </div>

  {#each filtered as t (t.num)}
    <div class="card" class:sent-card={t.sent}>
      <div class="row between">
        <div>
          <div class="row gap-md">
            <span class="mono dim">#{String(t.num).padStart(2, "0")}</span>
            <strong>{t.name}</strong>
            {#if t.sent}
              <span class="status-pill sent">✓ enviado {t.sentAt ?? ""}</span>
            {:else}
              <span class="status-pill pending">pendiente</span>
            {/if}
            {#if t.founderName}
              <span class="faint">→ {t.founderName}</span>
            {/if}
            {#if t.linkedin}
              <a href={t.linkedin} target="_blank" rel="noopener" class="faint mono">[directo]</a>
            {/if}
            <a href={t.linkedinSearch} target="_blank" rel="noopener" class="faint mono">[buscar]</a>
            {#if t.site}
              <a href={t.site} target="_blank" rel="noopener" class="faint mono">[web]</a>
            {/if}
          </div>
        </div>
        <div class="row gap-sm">
          <button onclick={() => toggle(t.num)}>{expanded.has(t.num) ? "ocultar" : "ver"}</button>
          {#if t.message && !t.sent}
            <button class="primary" onclick={() => copyAndOpen(t)}>copiar + abrir</button>
            <button onclick={() => searchOnly(t)} title="si el link directo no funciona, usá búsqueda">buscar</button>
          {/if}
          {#if !t.sent}
            <button onclick={() => markSent(t)}>marcar enviado</button>
          {/if}
        </div>
      </div>

      {#if expanded.has(t.num)}
        <div class="expanded">
          {#if t.message}
            <div class="section-title">mensaje ({t.message.split(/\s+/).length} palabras)</div>
            <pre class="message">{t.message}</pre>
          {:else}
            <div class="faint">todavía no hay mensaje drafteado — correr <code class="mono">npx tsx bin/batch-outreach.ts</code></div>
          {/if}

          <div class="section-title">research</div>
          <pre class="message" style="max-height: 280px; overflow: auto">{t.summary}</pre>
        </div>
      {/if}
    </div>
  {/each}
{/if}
