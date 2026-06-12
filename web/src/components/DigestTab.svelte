<script lang="ts">
  import { api, type Digest, type DigestItem } from "../lib/api.ts";

  let { notify, count = $bindable() }: { notify: (m: string) => void; count: number } = $props();

  let data = $state<Digest>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let expanded = $state<Set<string>>(new Set());

  async function load() {
    try {
      loading = true;
      data = await api.digest();
      count = data?.items.length ?? 0;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  load();

  function scoreClass(n: number) {
    if (n >= 75) return "high";
    if (n >= 60) return "med";
    return "low";
  }

  function toggle(url: string) {
    if (expanded.has(url)) expanded.delete(url);
    else expanded.add(url);
    expanded = new Set(expanded);
  }

  function applyTarget(item: DigestItem): { url: string; label: string } {
    if (item.job.applyEmail) {
      const subject = encodeURIComponent(`Application: ${item.job.title ?? "Senior Product Engineer"}`);
      const body = encodeURIComponent(
        `Hi,\n\nI'm reaching out about your post on ${item.job.source}.\n\n(Draft body in clipboard — paste here.)\n\n— YOUR_NAME\nhttps://github.com/YOUR_USERNAME\nhttps://app.example.com`,
      );
      return {
        url: `mailto:${item.job.applyEmail}?subject=${subject}&body=${body}`,
        label: `email ${item.job.applyEmail}`,
      };
    }
    if (item.job.applyUrl) return { url: item.job.applyUrl, label: "abrir página de careers" };
    return { url: item.job.url, label: "abrir post original" };
  }

  async function apply(item: DigestItem) {
    const target = applyTarget(item);
    const draft = `# Job: ${item.job.title ?? "(sin título)"} @ ${item.job.company ?? "?"}\n\n${item.job.url}\n${item.job.applyUrl ? `Apply: ${item.job.applyUrl}\n` : ""}${item.job.applyEmail ? `Email: ${item.job.applyEmail}\n` : ""}\n---\n\n${item.job.text}`;
    await api.clipboard(draft);
    await api.open(target.url);
    const app = await api.addApplication({
      url: item.job.applyUrl ?? item.job.url,
      platform: item.job.source,
      company: item.job.company ?? "?",
      title: item.job.title ?? undefined,
    });
    notify(`aplicado · ${app.id} · ${target.label}`);
  }

  let autoBusy = $state<string | null>(null);
  async function autoApply(item: DigestItem, mode: "auto" | "review") {
    const u = item.job.applyUrl ?? item.job.url;
    if (item.job.applyEmail && !item.job.applyUrl) {
      notify("este es de email — usá el botón aplicar");
      return;
    }
    autoBusy = u;
    notify(`auto-aplicar ${mode === "review" ? "revisar" : "automático"} → ${item.job.company ?? "?"} · mirá la terminal`);
    try {
      const r = await api.autoApply(u, mode);
      if (r.code === 0) notify(`✓ enviado · ${item.job.company ?? "?"}`);
      else if (r.code === 2) notify(`cancelado · ${item.job.company ?? "?"}`);
      else notify(`auto-apply terminó con código ${r.code}${r.error ? ` · ${r.error}` : ""}`);
    } catch (e) {
      notify(`falló auto-apply: ${(e as Error).message}`);
    } finally {
      autoBusy = null;
    }
  }

  async function copyText(text: string, label: string) {
    await api.clipboard(text);
    notify(`copiado ${label}`);
  }
</script>

{#if loading}
  <div class="empty">cargando empleos…</div>
{:else if error}
  <div class="empty">error: {error}</div>
{:else if !data || data.items.length === 0}
  <div class="empty">
    todavía no hay digest — andá a la tab <strong>Comando</strong> y clickeá
    <em>"Buscar empleos nuevos"</em>
  </div>
{:else}
  <div class="row between" style="margin-bottom: 16px">
    <div class="dim">
      digest <span class="mono">{data.date}</span> · {data.items.length} empleos ·
      generado {new Date(data.generatedAt).toLocaleTimeString()}
    </div>
    <button onclick={load}>refrescar</button>
  </div>

  {#each data.items as item (item.job.url)}
    <div class="card">
      <div class="row between">
        <div>
          <div class="row gap-md">
            <span class="score-pill {scoreClass(item.score.total)}">{item.score.total}</span>
            <strong>{item.job.title ?? "(sin título)"}</strong>
            <span class="dim">@ {item.job.company ?? "?"}</span>
          </div>
          <div class="faint mono" style="margin-top: 4px">{item.score.oneLiner}</div>
          <div class="tag-row">
            {#each item.score.flags as f}
              <span class="flag">{f}</span>
            {/each}
            {#if item.job.salary}
              <span class="flag" style="border-color: var(--good); color: var(--good)">{item.job.salary}</span>
            {/if}
            <span class="flag">{item.job.source}</span>
          </div>
        </div>
        <div class="row gap-sm">
          <button onclick={() => toggle(item.job.url)}>{expanded.has(item.job.url) ? "ocultar" : "detalles"}</button>
          <button onclick={() => apply(item)}>abrir + copiar</button>
          {#if item.job.applyUrl}
            <button onclick={() => autoApply(item, "review")} disabled={autoBusy !== null}>llenar (revisar)</button>
            <button class="primary" onclick={() => autoApply(item, "auto")} disabled={autoBusy !== null}>
              {autoBusy === (item.job.applyUrl ?? item.job.url) ? "llenando…" : "auto-aplicar"}
            </button>
          {/if}
        </div>
      </div>

      {#if expanded.has(item.job.url)}
        <div class="expanded">
          <div class="section-title">desglose del score</div>
          <div class="row gap-md faint mono">
            <span>stack {item.score.stackFit}</span>
            <span>seniority {item.score.seniorityFit}</span>
            <span>comp {item.score.compensation}</span>
            <span>etapa {item.score.companyStage}</span>
            <span>red flags {item.score.redFlags}</span>
          </div>

          <div class="section-title">texto del post</div>
          <pre class="message">{item.job.text}</pre>

          <div class="row gap-sm" style="flex-wrap: wrap">
            <a href={item.job.url} target="_blank" rel="noopener">post original ↗</a>
            {#if item.job.applyUrl}
              <a href={item.job.applyUrl} target="_blank" rel="noopener" style="color: var(--good)">página de aplicación ↗</a>
            {/if}
            {#if item.job.applyEmail}
              <a href={`mailto:${item.job.applyEmail}`} style="color: var(--good)">email {item.job.applyEmail}</a>
            {/if}
            <button onclick={() => copyText(item.job.applyUrl ?? item.job.url, "url")}>copiar url</button>
            <button onclick={() => copyText(item.job.text, "texto del post")}>copiar texto</button>
          </div>
        </div>
      {/if}
    </div>
  {/each}
{/if}
