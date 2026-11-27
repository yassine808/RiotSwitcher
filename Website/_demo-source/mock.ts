/* Fake Electron bridge + backend for the website demo. Dummy accounts only; nothing real is read or written. */
type Json = Record<string, any>;
const BASE = import.meta.env.BASE_URL;
const PRE = (window as any).__CARDS as Record<string, string> | undefined; // set only by the single-file preview
const cardUrl = (n: string) => PRE?.[n] ?? `${BASE}cards/${n}_Mastery_Card_animated.webp`;
const CARD_NAMES = ["Astra","Breach","Brimstone","Chamber","Clove","Cypher","Deadlock","Fade","Gekko","Harbor","Hush","Iso","Jett","KAYO","Killjoy","Miks","Neon","Omen","Phoenix","Raze","Reyna","Sage","Skye","Sova","Tejo","Veto","Viper","Vyse","Waylay","Yoru"];

const listeners = new Set<(d: { event: string; params: unknown }) => void>();
const emit = (event: string, params: unknown = {}) => listeners.forEach((l) => l({ event, params }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* public valorant-api.com data (agent icons, rank icons, maps). The demo still works if it is unreachable. */
const api = async (p: string): Promise<any[] | null> => {
  try { const r = await fetch("https://valorant-api.com/v1/" + p); return (await r.json()).data; } catch { return null; }
};
const ready = (async () => {
  const [agents, tiers, maps, cards] = await Promise.all([api("agents?isPlayableCharacter=true"), api("competitivetiers"), api("maps"), api("playercards")]);
  return { agents: agents ?? [], tiers: (tiers?.at(-1)?.tiers ?? []) as any[], maps: maps ?? [], cards: cards ?? [] };
})();

const seed = (s: string) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return () => ((h = (h * 1103515245 + 12345) >>> 0) / 4294967296); };
const MAPS = ["Ascent", "Bind", "Haven", "Split", "Lotus", "Sunset", "Icebox"];

interface Seed { name: string; card: string; agent: string; tier: number; rr: number; w: number; l: number }
const SEEDS: Seed[] = [
  { name: "Nova#EUW", card: "Reyna", agent: "Reyna", tier: 15, rr: 51, w: 36, l: 59 },
  { name: "Pixel#0001", card: "Jett", agent: "Jett", tier: 12, rr: 54, w: 16, l: 17 },
  { name: "Quiet#2468", card: "Sage", agent: "Sage", tier: 24, rr: 120, w: 88, l: 61 },
];
const SPARE: Seed[] = [
  { name: "Ember#7710", card: "Omen", agent: "Omen", tier: 0, rr: 0, w: 0, l: 0 },
  { name: "Frost#4412", card: "Sova", agent: "Sova", tier: 18, rr: 33, w: 21, l: 19 },
];

let profiles: Json[] = [];
let running: string | null = null;
let ctx: Awaited<typeof ready>;

function build(s: Seed): Json {
  const rnd = seed(s.name);
  const ag = ctx.agents.find((a) => a.displayName === s.agent);
  const others = ctx.agents.filter((a) => a.displayName !== s.agent).slice(0, 8);
  const pool = [ag, ...others].filter(Boolean);
  const tier = ctx.tiers.find((t) => t.tier === s.tier);
  const total = s.w + s.l;
  const map_stats = MAPS.map((m) => {
    const games = Math.round(4 + rnd() * 12), wins = Math.round(games * (0.35 + rnd() * 0.35));
    const agents = pool.slice(0, 3).map((a, i) => { const g = Math.max(1, Math.round(games / (i + 1.5))), w = Math.round(g * (0.3 + rnd() * 0.5));
      return { agent: a.displayName, games: g, wins: w, winrate: Math.round((w / g) * 100), avg_score: Math.round(180 + rnd() * 120), display_icon: a.displayIcon, role: a.role?.displayName ?? "" }; });
    return { map: m, games, wins, winrate: Math.round((wins / games) * 100), avg_score: Math.round(190 + rnd() * 110), agents };
  });
  return {
    profile_name: s.name, description: "", valorant_puuid: "demo-" + s.name, valorant_region: "eu", valorant_in_game_name: s.name,
    is_running: false,
    valorant_data: {
      tier: s.tier, rank_name: tier?.tierName ?? (s.tier ? "" : "Unranked"), rr: s.rr, peak_rank_name: tier?.tierName ?? "", wins: s.w, losses: s.l, games: total,
      last_played_ms: Date.now() - 3600_000, last_updated_ms: Date.now(), act_id: "demo", top_agent: s.agent, avg_combat_score: 212,
      agent_stats: pool.slice(0, 4).map((a, i) => ({ agent: a.displayName, games: 20 - i * 4, winrate: 55 - i * 5 })),
      recent_matches: pool.slice(0, 5).map((a, i) => ({ agent: a.displayName, map: MAPS[i], result: i % 3 === 1 ? "loss" : "win", score: 210 + i * 9, kills: 17 - i, deaths: 12 + i, assists: 4 + i })),
      map_stats, agent_portrait: ag?.fullPortrait ?? "", agent_display_icon: ag?.displayIcon ?? "", agent_role: ag?.role?.displayName ?? "",
      agent_bg: ag ? `https://media.valorant-api.com/agents/${ag.uuid}/background.png` : "", agent_bg_colors: ag?.backgroundGradientColors ?? [],
      rank_icon: tier?.largeIcon ?? "", player_card_bg: cardUrl(s.card),
    },
  };
}

const cfg: Json = { BackgroundTheme: "midnight", LaunchProduct: "valorant", CloseToTray: true, MinimizeToTray: true, Language: "en", SyncGameSettings: false, PerMapStats: true };
const out = () => profiles.map((p) => ({ ...p, is_running: p.profile_name === running }));
let detect: ReturnType<typeof setTimeout>[] = [];
const clear = () => { detect.forEach(clearTimeout); detect = []; };

const handlers: Record<string, (p: Json) => any> = {
  get_config: () => cfg,
  set_config: ({ key, value }) => { cfg[key] = value; return { ok: true }; },
  get_profiles: () => out(),
  get_valorant_maps: () => ctx.maps.filter((m) => m.tacticalDescription).map((m) => ({ name: m.displayName, splash: m.splash, display_icon: m.displayIcon, thumbnail: m.listViewIcon })),
  get_playercards: () => ctx.cards.map((c) => ({ uuid: c.uuid, displayName: c.displayName, largeArt: c.largeArt })),
  set_playercard: ({ name, card_url }) => { const p = profiles.find((x) => x.profile_name === name); if (p) p.valorant_data.player_card_bg = card_url; return { ok: true }; },
  delete_profile: ({ name }) => { profiles = profiles.filter((p) => p.profile_name !== name); if (running === name) running = null; return { ok: true }; },
  reorder_profiles: ({ names }) => { profiles.sort((a, b) => names.indexOf(a.profile_name) - names.indexOf(b.profile_name)); return { ok: true }; },
  refresh_valorant: () => { setTimeout(() => emit("valorant_data_updated", {}), 700); return { ok: true }; },
  quit_valorant: () => ({ ok: true }),
  sign_out_profile: () => { running = null; setTimeout(() => emit("riot_client_status", {}), 300); return { ok: true }; },
  account_detection_state: () => false,
  capture_current_account: () => ({ added: false, reason: "none", display: "" }),
  confirm_account_save: () => ({ ok: true }),
  stop_account_detection: () => { clear(); emit("account_detection_progress", { status: "canceled", message: "Canceled" }); return true; },
  start_account_detection: () => {
    clear();
    const next = SPARE.find((s) => !profiles.some((p) => p.profile_name === s.name));
    const step = (ms: number, fn: () => void) => detect.push(setTimeout(fn, ms));
    step(300, () => emit("account_detection_progress", { status: "opening", message: "Opening Riot Client…" }));
    step(1500, () => emit("account_detection_progress", { status: "waiting", message: "Waiting for sign in…" }));
    step(4200, () => {
      if (!next) return emit("account_detection_progress", { status: "already_added", message: "Already added" });
      profiles.push(build(next));
      emit("account_detection_progress", { status: "created", message: "Account added", display: next.name, profile_name: next.name });
      emit("profile_created", { profile_name: next.name });
    });
    return { ok: true };
  },
  launch_profile: async ({ name }) => {
    const steps: [string, string][] = running ? [["kill", "Closing Riot Client…"], ["save", "Saving the current session…"], ["restore", `Restoring ${name}…`], ["launch", "Launching the Riot Client…"]]
      : [["restore", `Restoring ${name}…`], ["launch", "Launching the Riot Client…"]];
    for (const [step, message] of steps) { emit("profile_switch_progress", { step, status: "pending", message }); await wait(650); }
    running = name;
    emit("profile_switch_progress", { step: "launch", status: "done", message: "Launched" });
    // tell the website around the demo which card is live, so its background can follow
    parent.postMessage({ rs: "card", src: profiles.find((p) => p.profile_name === name)?.valorant_data.player_card_bg }, location.origin);
    emit("riot_client_status", {});
    return { ok: true };
  },
};

(window as any).electronAPI = {
  minimize: async () => {}, close: async () => {}, toggleMaximize: async () => {},
  getVersion: async () => { try { const r = await fetch("/api/latest"); return (await r.json()).version ?? "3.1.12"; } catch { return "3.1.12"; } },
  checkUpdate: async () => { const s = (state: string) => listeners2.forEach((l) => l({ state })); s("checking"); await wait(900); s("up-to-date"); },
  downloadUpdate: async () => {}, installUpdate: async () => {},
  onUpdateStatus: (cb: (d: any) => void) => { listeners2.add(cb); return () => listeners2.delete(cb); },
  getAnimatedCards: async () => CARD_NAMES.filter((n) => !PRE || PRE[n]).map((n) => ({ name: n, url: cardUrl(n) })),
  copyText: async (t: string) => { try { await navigator.clipboard.writeText(t); } catch { /* ignore */ } },
  createProfileShortcut: async () => ({ ok: true, path: "Desktop" }),
  openExternal: async (u: string) => { window.open(u, "_blank", "noopener"); },
  call: async (method: string, params: Json = {}) => { await ready; if (!profiles.length) profiles = SEEDS.map(build); return handlers[method]?.(params) ?? null; },
  onEvent: (cb: (d: { event: string; params: unknown }) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
};
const listeners2 = new Set<(d: any) => void>();
ready.then((c) => { ctx = c; profiles = SEEDS.map(build); }).catch(() => { /* the demo still works without the public API */ });

// first click inside the demo lets the website start its ambient sound (browsers need a click)
addEventListener("pointerdown", () => parent.postMessage({ rs: "interact" }, location.origin), { once: true });
