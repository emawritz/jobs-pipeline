<script lang="ts">
  import DigestTab from "./components/DigestTab.svelte";
  import ApplicationsTab from "./components/ApplicationsTab.svelte";
  import OutreachTab from "./components/OutreachTab.svelte";
  import ComandoTab from "./components/ComandoTab.svelte";
  import SistemaTab from "./components/SistemaTab.svelte";
  import RespuestasTab from "./components/RespuestasTab.svelte";
  import PromptsTab from "./components/PromptsTab.svelte";
  import Toast from "./components/Toast.svelte";

  type Tab = "comando" | "digest" | "applications" | "outreach" | "respuestas" | "prompts" | "sistema";
  let active = $state<Tab>("comando");
  let toast = $state<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function notify(msg: string) {
    toast = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2200);
  }

  let appCount = $state(0);
  let outreachCount = $state(0);
  let digestCount = $state(0);
</script>

<div class="app-shell">
  <header class="top">
    <div class="brand">centro<span class="dot">.</span>operaciones</div>
    <nav>
      <button class:active={active === "comando"} onclick={() => (active = "comando")}>
        Comando
      </button>
      <button class:active={active === "digest"} onclick={() => (active = "digest")}>
        Empleos{digestCount ? ` · ${digestCount}` : ""}
      </button>
      <button class:active={active === "applications"} onclick={() => (active = "applications")}>
        Aplicaciones{appCount ? ` · ${appCount}` : ""}
      </button>
      <button class:active={active === "outreach"} onclick={() => (active = "outreach")}>
        LinkedIn{outreachCount ? ` · ${outreachCount}` : ""}
      </button>
      <button class:active={active === "respuestas"} onclick={() => (active = "respuestas")}>
        Respuestas
      </button>
      <button class:active={active === "prompts"} onclick={() => (active = "prompts")}>
        Prompts
      </button>
      <button class:active={active === "sistema"} onclick={() => (active = "sistema")}>
        Sistema
      </button>
    </nav>
    <div class="spacer"></div>
    <div class="meta">YOUR_NAME · {new Date().toISOString().slice(0, 10)}</div>
  </header>

  <main class="content">
    {#if active === "comando"}
      <ComandoTab {notify} />
    {:else if active === "digest"}
      <DigestTab {notify} bind:count={digestCount} />
    {:else if active === "applications"}
      <ApplicationsTab {notify} bind:count={appCount} />
    {:else if active === "outreach"}
      <OutreachTab {notify} bind:count={outreachCount} />
    {:else if active === "respuestas"}
      <RespuestasTab {notify} />
    {:else if active === "prompts"}
      <PromptsTab />
    {:else}
      <SistemaTab {notify} />
    {/if}
  </main>

  {#if toast}
    <Toast text={toast} />
  {/if}
</div>
