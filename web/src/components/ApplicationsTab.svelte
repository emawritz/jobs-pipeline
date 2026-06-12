<script lang="ts">
  import { api, type Application } from "../lib/api.ts";

  let { notify, count = $bindable() }: { notify: (m: string) => void; count: number } = $props();

  let apps = $state<Application[]>([]);
  let loading = $state(true);
  let platformFilter = $state<string>("all");

  // Status canónico (en inglés en la DB) → etiqueta en español + orden.
  const STATUSES = [
    { key: "applied", label: "enviadas" },
    { key: "replied", label: "respondieron" },
    { key: "interviewing", label: "entrevistando" },
    { key: "offer", label: "oferta" },
    { key: "rejected", label: "rechazadas" },
    { key: "ghosted", label: "ghosted" },
  ] as const;

  // Etiquetas español para los próximos botones (más cortas).
  const STATUS_SHORT: Record<string, string> = {
    applied: "env",
    replied: "resp",
    interviewing: "entr",
    offer: "oferta",
    rejected: "rech",
    ghosted: "ghost",
  };

  async function load() {
    loading = true;
    apps = await api.applications();
    count = apps.length;
    loading = false;
  }

  load();

  async function setStatus(id: string, status: string) {
    const updated = await api.updateApplication(id, { status });
    apps = apps.map((a) => (a.id === id ? updated : a));
    const label = STATUSES.find((s) => s.key === status)?.label ?? status;
    notify(`${id} → ${label}`);
  }

  function bucket(s: string) {
    return filtered.filter((a) => a.status === s);
  }

  function daysSince(iso: string) {
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }

  // Plataformas únicas para filtro.
  let platforms = $derived(
    Array.from(new Set(apps.map((a) => a.platform))).sort(),
  );

  let filtered = $derived(
    platformFilter === "all" ? apps : apps.filter((a) => a.platform === platformFilter),
  );
</script>

{#if loading}
  <div class="empty">cargando aplicaciones…</div>
{:else if apps.length === 0}
  <div class="empty">
    todavía no hay aplicaciones — disparalas desde la tab <strong>Comando</strong> o
    desde <strong>Empleos</strong>
  </div>
{:else}
  <div class="row between" style="margin-bottom: 12px">
    <div class="dim">
      {filtered.length} de {apps.length} aplicaciones
    </div>
    <div class="row gap-sm" style="flex-wrap: wrap; align-items: center">
      <label class="dim mono" style="font-size: 11px">plataforma:</label>
      <select bind:value={platformFilter} class="filter-select">
        <option value="all">todas</option>
        {#each platforms as p}
          <option value={p}>{p}</option>
        {/each}
      </select>
      <button onclick={load}>refrescar</button>
    </div>
  </div>

  <div class="kanban">
    {#each STATUSES as s}
      <div class="column">
        <h3>{s.label} · {bucket(s.key).length}</h3>
        {#each bucket(s.key) as a (a.id)}
          <div class="item">
            <div><strong>{a.company ?? "?"}</strong></div>
            <div class="faint">{a.title ?? "—"}</div>
            <div class="faint mono" style="margin-top: 3px">{a.platform} · d+{daysSince(a.appliedAt)}</div>
            <div class="row gap-sm" style="margin-top: 5px; flex-wrap: wrap">
              <a href={a.url} target="_blank" rel="noopener" class="faint">↗ url</a>
              {#each STATUSES as next}
                {#if next.key !== a.status}
                  <button style="font-size: 10px; padding: 2px 6px" onclick={() => setStatus(a.id, next.key)} title="marcar como {next.label}">
                    {STATUS_SHORT[next.key] ?? next.key.slice(0, 3)}
                  </button>
                {/if}
              {/each}
            </div>
            {#if a.notes.length > 0}
              <div class="faint" style="margin-top: 5px; font-size: 10px">
                {a.notes[a.notes.length - 1]}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
{/if}

<style>
  .filter-select {
    background: var(--surface, #1a1a1a);
    color: inherit;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
  }
</style>
