// podcast — Pocket Casts podcast player inside pi.
//
// Commands:
//   /podcast                     interactive main menu
//   /podcast login               email + password → store token in OS keychain
//   /podcast logout              forget token
//   /podcast subs                 list subscriptions → pick → episodes → play
//   /podcast new                  new releases → pick → play
//   /podcast continue             in-progress episodes → pick → resume
//   /podcast search <query>       search → pick podcast → episodes → play
//   /podcast trending|popular|featured   browse public lists
//   /podcast pause|resume|stop|now       playback control
//
// Requires mpv on PATH (winget install mpv).
// Requires Pocket Casts Plus subscription.
// Auth stored via @napi-rs/keyring (Windows Credential Manager).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn, execSync, ChildProcess } from "child_process";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";

// ── constants ───────────────────────────────────────────────────────────────
const WIDGET_KEY = "podcast";
const API = "https://api.pocketcasts.com";
const LISTS = "https://lists.pocketcasts.com";
const PODCAST_API = "https://podcast-api.pocketcasts.com";
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Referer: "https://www.pocketcasts.com/",
};
const SYNC_INTERVAL_MS = 15000;
// ponytail: Windows mpv builds often lack TCP IPC, use named pipes
const IS_WINDOWS = process.platform === "win32";

// ── types ───────────────────────────────────────────────────────────────────
interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface Podcast {
  uuid: string;
  title: string;
  author: string;
  description?: string;
  episodeCount?: number;
  url?: string; // RSS feed URL
}

interface Episode {
  uuid: string;
  title: string;
  url: string; // audio stream URL — the key field for playback
  podcastUuid: string;
  podcastTitle: string;
  author?: string;
  published: string;
  duration: number; // seconds
  playedUpTo?: number; // seconds
  isPlayed?: boolean;
  size?: number;
  contentType?: string;
}

// ── keychain wrapper (@napi-rs/keyring: Windows Credential Manager) ────────
// Tokens are stored in OS keychain — never touches disk.
// Fallback: if keyring fails at runtime (e.g. no credential manager), reverts to
// a 0600 file at ~/.config/pi/podcast.json.

const SERVICE = "pi-podcast";
const ACCOUNT = "pocketcasts";

async function keyringAvailable(): Promise<boolean> {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    void Entry; // touch
    return true;
  } catch {
    return false;
  }
}

async function saveTokens(t: StoredTokens): Promise<void> {
  if (await keyringAvailable()) {
    const { Entry } = await import("@napi-rs/keyring");
    new Entry(SERVICE, ACCOUNT).setPassword(JSON.stringify(t));
  } else {
    // ponytail: file fallback for systems without credential manager
    const filePath = TOKEN_FILE();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(t), { mode: 0o600 });
  }
}

async function loadTokens(): Promise<StoredTokens | null> {
  if (await keyringAvailable()) {
    try {
      const { Entry } = await import("@napi-rs/keyring");
      const raw = new Entry(SERVICE, ACCOUNT).getPassword();
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  try {
    const raw = fs.readFileSync(TOKEN_FILE(), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

async function clearTokens(): Promise<void> {
  if (await keyringAvailable()) {
    try { const { Entry } = await import("@napi-rs/keyring"); new Entry(SERVICE, ACCOUNT).deletePassword(); } catch {}
  }
  try { fs.unlinkSync(TOKEN_FILE()); } catch {}
}

function TOKEN_FILE(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".config", "pi", "podcast.json",
  );
}

// ... and the rest described inline.

// ── PocketCastsClient ───────────────────────────────────────────────────────
// One instance per session. Token state managed via keychain (or file fallback).
// On every authed request, ensureToken() checks expiry and refreshes if needed.

let pc: PocketCastsClient | null = null;

class PocketCastsClient {
  private tokens: StoredTokens | null = null;
  private _tokensLoaded = false;

  constructor() {
    // tokens loaded lazily on first ensureToken() call
  }

  async init(): Promise<void> {
    if (this._tokensLoaded) return;
    this.tokens = await loadTokens();
    this._tokensLoaded = true;
  }

  get isAuthed(): boolean {
    return !!(this.tokens?.accessToken);
  }

  get email(): string {
    // Decode the JWT sub claim for display, or return "?"
    if (!this.tokens) return "?";
    try {
      const payload = this.tokens.accessToken.split(".")[1]!;
      return JSON.parse(Buffer.from(payload, "base64url").toString())?.sub ?? "?";
    } catch {
      return "?";
    }
  }

  // ── auth ──

  async login(email: string, password: string): Promise<boolean> {
    const res = await fetch(`${API}/user/login_pocket_casts`, {
      method: "POST",
      headers: { ...DEFAULT_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, scope: "webplayer" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.message || `Login failed (${res.status})`);
    }
    const data: any = await res.json();
    this.tokens = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000,
    };
    await saveTokens(this.tokens);
    return true;
  }

  async logout(): Promise<void> {
    this.tokens = null;
    await clearTokens();
  }

  private async ensureToken(): Promise<string> {
    await this.init();
    if (!this.tokens) throw new Error("Not authenticated. Run /podcast login.");
    if (Date.now() < this.tokens.expiresAt - 60_000) {
      return this.tokens.accessToken; // fresh enough
    }
    // Try refresh
    if (!this.tokens.refreshToken) {
      throw new Error("Token expired and no refresh token. Run /podcast login.");
    }
    const res = await fetch(`${API}/user/token`, {
      method: "POST",
      headers: { ...DEFAULT_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "refresh_token",
        refreshToken: this.tokens.refreshToken,
      }),
    });
    if (!res.ok) {
      this.tokens = null;
      await clearTokens();
      throw new Error("Token refresh failed. Run /podcast login.");
    }
    const data: any = await res.json();
    this.tokens = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000,
    };
    await saveTokens(this.tokens);
    return this.tokens.accessToken;
  }

  // ── authed helpers ──

  private async authedPost(path: string, body?: any, baseURL: string = API): Promise<any> {
    const token = await this.ensureToken();
    const res = await fetch(`${baseURL}${path}`, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
    return res.json();
  }

  // ── public API methods ──

  async getSubscriptions(): Promise<{ podcasts: Podcast[] }> {
    return this.authedPost("/user/podcast/list");
  }

  async getNewReleases(): Promise<{ episodes: Episode[] }> {
    return this.authedPost("/user/new_releases");
  }

  async getInProgress(): Promise<{ episodes: Episode[] }> {
    return this.authedPost("/user/in_progress");
  }

  async getStarred(): Promise<{ episodes: Episode[] }> {
    return this.authedPost("/user/starred");
  }

  async getHistory(): Promise<{ episodes: Episode[] }> {
    return this.authedPost("/user/history");
  }

  async getEpisode(uuid: string): Promise<Episode> {
    return this.authedPost("/user/episode", { uuid });
  }

  // ponytail: real position-sync endpoint. /user/episode only flips the
  // played flag; the playhead lives at /sync/update_episode on the same host.
  async updatePlayingStatus(
    uuid: string,
    podcastUuid: string,
    playedUpTo: number,
    playingStatus: 2 | 3, // 2=in-progress, 3=finished
  ): Promise<void> {
    await this.authedPost("/sync/update_episode", {
      uuid,
      podcast: podcastUuid,
      status: playingStatus,
      position: playedUpTo,
    });
  }

  async search(term: string): Promise<{ podcasts: Podcast[] }> {
    return this.authedPost("/discover/search", { term });
  }

  // ── public (no auth) ──

  async listJson(name: string): Promise<any> {
    const res = await fetch(`${LISTS}/${name}.json`, { headers: DEFAULT_HEADERS });
    if (!res.ok) throw new Error(`${name}.json ${res.status}`);
    return res.json();
  }

  async featured(): Promise<Podcast[]> {
    const data = await this.listJson("featured");
    return (data?.podcasts ?? []).map((p: any) => ({
      uuid: p.uuid,
      title: p.title,
      author: p.author ?? "",
      url: p.feed,
    }));
  }

  async popular(): Promise<Podcast[]> {
    const data = await this.listJson("popular");
    return (data?.podcasts ?? []).map((p: any) => ({
      uuid: p.uuid,
      title: p.title,
      author: p.author ?? "",
      url: p.feed,
    }));
  }

  async trending(): Promise<Podcast[]> {
    const data = await this.listJson("trending");
    return (data?.podcasts ?? []).map((p: any) => ({
      uuid: p.uuid,
      title: p.title,
      author: p.author ?? "",
      url: p.feed,
    }));
  }

  async getShowNotes(podcastUuid: string): Promise<any> {
    const res = await fetch(
      `${PODCAST_API}/show_notes/full/${podcastUuid}`,
      { headers: DEFAULT_HEADERS },
    );
    if (!res.ok) throw new Error(`show_notes ${res.status}`);
    return res.json();
  }
}

// ── helper: get episodes for a podcast ─────────────────────────────────────
// ponytail: limit to last N, show_notes is public so no per-user play status
async function getPodcastEpisodes(
  podcastUuid: string,
  fallback?: { title?: string; author?: string },
  limit = 20,
): Promise<Episode[]> {
  const data = await pc!.getShowNotes(podcastUuid);
  const podcastTitle = fallback?.title ?? data?.podcast?.title ?? "";
  const podcastAuthor = fallback?.author ?? data?.podcast?.author ?? "";
  const all = (data?.podcast?.episodes ?? []).map((e: any) => ({
    uuid: e.uuid,
    title: e.title,
    url: e.url,
    podcastUuid: podcastUuid,
    podcastTitle,
    author: podcastAuthor,
    published: e.published ?? "",
    duration: e.duration ?? 0,
    size: e.size,
    contentType: e.contentType,
  }));
  return all.slice(0, limit);
}

// ── mpv player ──────────────────────────────────────────────────────────────
// ponytail: mpv only, no ffplay. Windows → named pipes, Unix → TCP IPC.

let player: ChildProcess | null = null;
let mpvSocket: net.Socket | null = null;
let mpvIpcAddr = ""; // TCP port or named-pipe path
let nowPlaying: Episode | null = null;
let isPaused = false;
let currentPosition = 0; // seconds, updated by IPC poll
let syncTimer: ReturnType<typeof setInterval> | null = null;
let positionTimer: ReturnType<typeof setInterval> | null = null;

// ponytail: scan PATH + common Windows install locations for mpv
function findMpv(): string | null {
  // Check PATH first
  try { execSync("mpv --version", { stdio: "ignore" }); return "mpv"; } catch {}
  // Common install locations (no PATH needed)
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "MPV Player", "mpv.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "MPV Player", "mpv.exe"),
    path.join(localAppData, "Programs", "mpv", "mpv.exe"),
    // winget installs (shinchiro build, official CI)
    path.join(localAppData, "Microsoft", "WinGet", "Packages", "shinchiro.mpv_8wekyb3d8bbwe", "mpv.exe"),
    path.join(localAppData, "Microsoft", "WinGet", "Packages", "mpv-player.mpv-CI.MSVC_8wekyb3d8bbwe", "mpv.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ponytail: generate a unique IPC address per session
function ipcAddr(): string {
  if (IS_WINDOWS) {
    return `\\\\.\\pipe\\mpv-podcast-${process.pid}-${Date.now()}`;
  }
  return `tcp://127.0.0.1:0`; // port 0 lets findFreePort pick
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function mpvIpc(command: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!mpvSocket || mpvSocket.destroyed) return reject(new Error("No mpv socket"));
    const payload = JSON.stringify({ command }) + "\n";
    mpvSocket.write(payload);
    // mpv sends back a line per command; we'll handle responses in the read loop
    resolve(undefined); // fire-and-forget for most commands
  });
}

async function mpvGetProperty(prop: string): Promise<any> {
  if (!mpvSocket || mpvSocket.destroyed) return null;
  const payload = JSON.stringify({ command: ["get_property", prop] }) + "\n";
  mpvSocket.write(payload);
  // Response is read asynchronously in the read loop; we use a simple
  // position-poll approach instead of per-request promises.
  return null; // position polled via IPC read loop below
}

function labelEpisode(ep: Episode): string {
  const parts = [ep.title];
  if (ep.podcastTitle) parts.push(ep.podcastTitle);
  return parts.filter(Boolean).join(" — ");
}

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ponytail: 0–100% clamped, integer for display
function listeningPct(pos: number, dur: number): number {
  if (!dur || dur <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((pos / dur) * 100)));
}

// ponytail: Unicode block bar — single-width chars, no half-block smoothing
function progressBar(pct: number, width: number): string {
  const w = Math.max(1, width);
  const filled = Math.round((pct / 100) * w);
  return "█".repeat(filled) + "░".repeat(w - filled);
}

// sync progress back to Pocket Casts
// playingStatus: 2=in-progress, 3=finished
async function flushPosition(playingStatus: 2 | 3 = 2) {
  if (!pc || !nowPlaying || currentPosition <= 0) return;
  try {
    const pos = Math.floor(currentPosition);
    await pc.updatePlayingStatus(nowPlaying.uuid, nowPlaying.podcastUuid, pos, playingStatus);
  } catch (e) {
    // ponytail: log so silent failures are diagnosable, still don't crash
    console.error("[podcast] sync failed:", e);
  }
}

async function play(episode: Episode, ctx: ExtensionContext, startPos?: number): Promise<boolean> {
  const mpvPath = findMpv();
  if (!mpvPath) {
    ctx.ui.notify("mpv not found. Install it: winget install mpv", "error");
    return false;
  }

  stop(); // kill any existing player

  if (IS_WINDOWS) {
    mpvIpcAddr = ipcAddr();
  } else {
    try {
      const port = await findFreePort();
      mpvIpcAddr = `tcp://127.0.0.1:${port}`;
    } catch {
      ctx.ui.notify("Couldn't find a free port for mpv IPC.", "error");
      return false;
    }
  }

  // Resolve the actual audio stream URL
  let streamUrl = episode.url;
  if (!streamUrl) {
    try {
      if (!pc) throw new Error("Not authenticated.");
      const ep = await pc.getEpisode(episode.uuid);
      streamUrl = ep.url;
    } catch (e: any) {
      ctx.ui.notify(`Couldn't resolve stream: ${e.message}`, "error");
      return false;
    }
  }

  const args = [
    "--no-video",
    "--quiet",
    "--no-terminal",
    `--input-ipc-server=${mpvIpcAddr}`,
    `--force-media-title=${Buffer.from(labelEpisode(episode)).toString("utf8")}`,
    "--pause", // start paused to connect IPC first
  ];
  if (startPos && startPos > 0) {
    // ponytail: --start queues a seek at file-load time, so the resume
    // position is honored even for slow remote streams. The old IPC seek
    // raced the file loader and was silently dropped.
    args.push(`--start=${startPos}`);
  }
  args.push(streamUrl);

  nowPlaying = episode;
  isPaused = true;
  currentPosition = startPos ?? 0;

  player = spawn(mpvPath, args, { stdio: "ignore", detached: false });

  player.on("error", (err) => {
    ctx.ui.notify(`mpv error: ${err.message}`, "error");
    stop();
    clearWidget(ctx);
  });

  player.on("exit", (code) => {
    // Flush position on natural end (played through)
    flushPosition(3);
    player = null;
    mpvSocket = null;
    clearWidget(ctx);
    nowPlaying = null;
  });

  // Connect IPC socket after a short delay to let mpv start
  await new Promise((r) => setTimeout(r, 300));

  mpvSocket = new net.Socket();
  let ipcBuffer = "";

  await new Promise<void>((resolve, reject) => {
    if (IS_WINDOWS) {
      // named pipe — connect with path, not port
      (mpvSocket! as any).connect(mpvIpcAddr, () => resolve());
    } else {
      const port = parseInt(mpvIpcAddr.split(":").pop()!, 10);
      mpvSocket!.connect(port, "127.0.0.1", () => resolve());
    }
    mpvSocket!.on("error", reject);
    setTimeout(() => reject(new Error("mpv IPC connection timeout")), 3000);
  });

  let fileLoadedResolver!: () => void;
  const fileLoadedPromise = new Promise<void>((resolve) => {
    fileLoadedResolver = resolve;
  });

  mpvSocket.on("data", (data: Buffer) => {
    ipcBuffer += data.toString();
    const lines = ipcBuffer.split("\n");
    ipcBuffer = lines.pop() ?? ""; // keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg?.event === "property-change" && msg?.name === "time-pos") {
          currentPosition = msg.data ?? 0;
          widgetComponent?.invalidate();
        }
        if (msg?.event === "file-loaded") {
          fileLoadedResolver();
        }
        if (msg?.event === "end-file") {
          // Natural end of file
        }
        if (msg?.event === "pause") {
          isPaused = true;
        }
        if (msg?.event === "unpause") {
          isPaused = false;
        }
      } catch {
        // invalid JSON from mpv (unlikely)
      }
    }
  });

  mpvSocket.on("close", () => {
    mpvSocket = null;
  });

  // Observe position property
  mpvSocket.write(
    JSON.stringify({ command: ["observe_property", 1, "time-pos"] }) + "\n",
  );

  // Wait for the file to finish loading before unpausing, so --start has
  // been applied and the first time-pos is the real resume position.
  await Promise.race([
    fileLoadedPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 10000)),
  ]);

  mpvSocket.write(JSON.stringify({ command: ["set_property", "pause", false] }) + "\n");
  isPaused = false;

  // ponytail: announce to Pocket Casts that we're playing this episode
  pc?.updatePlayingStatus(episode.uuid, episode.podcastUuid, Math.floor(currentPosition), 2).catch((e) => {
    console.error("[podcast] initial sync failed:", e);
  });

  // ── position polling (reads from ipcBuffer via currentPosition updates) ─
  // We also query time-pos periodically in case the observe misses updates
  positionTimer = setInterval(() => {
    if (mpvSocket && !mpvSocket.destroyed) {
      mpvSocket.write(
        JSON.stringify({ command: ["get_property", "time-pos"] }) + "\n",
      );
      // The response will be in the read loop; for simplicity we also
      // rely on property-change events above
    }
  }, 1000);

  // ── sync-back timer ─
  // ponytail: also sync while paused so the paused position reaches the server
  syncTimer = setInterval(() => {
    if (!nowPlaying || currentPosition <= 0) return;
    flushPosition(2);
  }, SYNC_INTERVAL_MS);

  showWidget(ctx, episode);
  ctx.ui.notify(`Now playing: ${labelEpisode(episode)}`, "info");
  return true;
}

function stop() {
  if (positionTimer) { clearInterval(positionTimer); positionTimer = null; }
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }

  if (mpvSocket) {
    try { mpvSocket.write(JSON.stringify({ command: ["quit"] }) + "\n"); } catch {}
    mpvSocket.destroy();
    mpvSocket = null;
  }

  if (player) {
    player.removeAllListeners("exit");
    try { player.kill("SIGTERM"); } catch {}
    // On Windows, SIGTERM -> SIGKILL after timeout; give it a moment
    setTimeout(() => {
      if (player) {
        try { player.kill("SIGKILL"); } catch {}
        player = null;
      }
    }, 1000);
    player = null;
  }

  isPaused = false;
}

async function pausePlayback(ctx: ExtensionContext): Promise<void> {
  if (!nowPlaying) return;
  try {
    await mpvIpc(["set_property", "pause", true]);
    isPaused = true;
    await flushPosition(2);
  } catch { /* ignore */ }
  updateWidget(ctx);
}

async function resumePlayback(ctx: ExtensionContext): Promise<void> {
  if (!nowPlaying) return;
  try {
    await mpvIpc(["set_property", "pause", false]);
    isPaused = false;
  } catch { /* ignore */ }
  updateWidget(ctx);
}

async function seekPlayback(seconds: number, ctx: ExtensionContext): Promise<void> {
  if (!nowPlaying) return;
  try {
    await mpvIpc(["seek", seconds, "relative"]);
  } catch { /* ignore */ }
}

async function skipForward(ctx: ExtensionContext): Promise<void> {
  await seekPlayback(30, ctx);
}

async function skipBack(ctx: ExtensionContext): Promise<void> {
  await seekPlayback(-15, ctx);
}

// ── widget ──────────────────────────────────────────────────────────────────
// ponytail: keep a handle to the live widget so position events can invalidate it
let widgetComponent: { invalidate: () => void } | null = null;

function widgetText(ep: Episode, renderWidth: number): string {
  const pctVal = listeningPct(currentPosition, ep.duration);
  const ico = isPaused ? "⏸" : "▶";
  // Fixed-width bar; truncate the label so the whole line fits the terminal.
  const barWidth = 20;
  // "🎙 " + "  [" + "]" + " XX%" + "  ▶" ≈ 14 chars of overhead
  const overhead = 14;
  const labelMax = Math.max(5, renderWidth - overhead - barWidth);
  let label = labelEpisode(ep);
  if (label.length > labelMax) {
    label = label.slice(0, Math.max(1, labelMax - 1)) + "…";
  }
  const bar = progressBar(pctVal, barWidth);
  return `🎙 ${label}  [${bar}] ${pctVal}%  ${ico}`;
}

function showWidget(ctx: ExtensionContext, ep: Episode) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    WIDGET_KEY,
    (_tui: any, theme: any) => {
      const component = {
        render: (width: number) => {
          // Fresh Text each render — currentPosition is read from module state,
          // so every redraw reflects the latest position.
          return new Text(theme.fg("accent", widgetText(ep, width)), 0, 0).render(width);
        },
        invalidate: () => {},
      };
      widgetComponent = component;
      return component;
    },
    { placement: "belowEditor" },
  );
}

function updateWidget(ctx: ExtensionContext) {
  if (!nowPlaying || !ctx.hasUI) return;
  showWidget(ctx, nowPlaying);
}

function clearWidget(ctx: ExtensionContext) {
  widgetComponent = null;
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

// ── interactive flows ───────────────────────────────────────────────────────

async function pickFromList<T>(
  items: T[],
  labelFn: (item: T) => string,
  title: string,
  ctx: ExtensionContext,
): Promise<T | null> {
  if (!items.length) {
    ctx.ui.notify("Nothing to show.", "info");
    return null;
  }
  const labels = items.map(labelFn);
  const choice = await ctx.ui.select(title, labels);
  if (!choice) return null;
  return items[labels.indexOf(choice)] ?? null;
}

async function loginFlow(ctx: ExtensionContext): Promise<void> {
  const email = await ctx.ui.input("Pocket Casts email", "");
  if (!email) return;
  const password = await ctx.ui.input(
    "Pocket Casts password",
    "(hidden — not stored in chat)",
  );
  if (!password) return;

  try {
    pc = new PocketCastsClient();
    await pc.login(email, password);
    ctx.ui.notify(`Logged in as ${pc.email}`, "success");
  } catch (e: any) {
    ctx.ui.notify(`Login failed: ${e.message}`, "error");
  }
}

async function subsFlow(ctx: ExtensionContext): Promise<void> {
  if (!pc?.isAuthed) { ctx.ui.notify("Not logged in. Run /podcast login.", "warning"); return; }
  let podcasts: Podcast[];
  try {
    const data = await pc.getSubscriptions();
    podcasts = data.podcasts ?? [];
  } catch (e: any) {
    ctx.ui.notify(`Failed: ${e.message}`, "error");
    return;
  }
  const podcast = await pickFromList(
    podcasts,
    (p) => `${p.title}${p.author ? ` (${p.author})` : ""}`,
    "Your subscriptions",
    ctx,
  );
  if (!podcast) return;

  let episodes: Episode[];
  try {
    episodes = await getPodcastEpisodes(podcast.uuid, { title: podcast.title, author: podcast.author });
  } catch (e: any) {
    ctx.ui.notify(`Couldn't load episodes: ${e.message}`, "error");
    return;
  }
  const episode = await pickFromList(
    episodes,
    (e) => `${e.title}  [${formatTime(e.duration)}]`,
    podcast.title,
    ctx,
  );
  if (episode) await play(episode, ctx);
}

async function newReleasesFlow(ctx: ExtensionContext): Promise<void> {
  if (!pc?.isAuthed) { ctx.ui.notify("Not logged in. Run /podcast login.", "warning"); return; }
  let data: { episodes: Episode[] };
  try {
    data = await pc.getNewReleases();
  } catch (e: any) {
    ctx.ui.notify(`Failed: ${e.message}`, "error");
    return;
  }
  const episode = await pickFromList(
    data.episodes ?? [],
    (e) => `${e.podcastTitle} — ${e.title}  [${formatTime(e.duration)}]`,
    "New releases",
    ctx,
  );
  if (episode) await play(episode, ctx);
}

async function inProgressFlow(ctx: ExtensionContext): Promise<void> {
  if (!pc?.isAuthed) { ctx.ui.notify("Not logged in. Run /podcast login.", "warning"); return; }
  let data: { episodes: Episode[] };
  try {
    data = await pc.getInProgress();
  } catch (e: any) {
    ctx.ui.notify(`Failed: ${e.message}`, "error");
    return;
  }
  const episode = await pickFromList(
    data.episodes ?? [],
    (e) => {
      const pos = formatTime(e.playedUpTo ?? 0);
      const dur = formatTime(e.duration);
      return `${e.podcastTitle} — ${e.title}  [${pos}/${dur}]`;
    },
    "In progress",
    ctx,
  );
  if (episode) await play(episode, ctx, episode.playedUpTo);
}

async function searchFlow(ctx: ExtensionContext, query?: string): Promise<void> {
  if (!pc?.isAuthed) { ctx.ui.notify("Not logged in. Run /podcast login.", "warning"); return; }
  const q = query || (await ctx.ui.input("Search", "e.g. Lex Fridman, 99% Invisible, This American Life"));
  if (!q) return;
  let data: { podcasts: Podcast[] };
  try {
    data = await pc.search(q);
  } catch (e: any) {
    ctx.ui.notify(`Search failed: ${e.message}`, "error");
    return;
  }
  const podcast = await pickFromList(
    data.podcasts ?? [],
    (p) => `${p.title}${p.author ? ` (${p.author})` : ""}`,
    `Search: "${q}"`,
    ctx,
  );
  if (!podcast) return;

  let episodes: Episode[];
  try {
    episodes = await getPodcastEpisodes(podcast.uuid, { title: podcast.title, author: podcast.author });
  } catch (e: any) {
    ctx.ui.notify(`Couldn't load episodes: ${e.message}`, "error");
    return;
  }
  const episode = await pickFromList(
    episodes,
    (e) => `${e.title}  [${formatTime(e.duration)}]`,
    podcast.title,
    ctx,
  );
  if (episode) await play(episode, ctx);
}

async function listFlow(
  name: string,
  label: string,
  ctx: ExtensionContext,
): Promise<void> {
  if (!pc) { pc = new PocketCastsClient(); }
  let podcasts: Podcast[];
  try {
    if (name === "trending") podcasts = await pc.trending();
    else if (name === "popular") podcasts = await pc.popular();
    else if (name === "featured") podcasts = await pc.featured();
    else throw new Error("Unknown list");
  } catch (e: any) {
    ctx.ui.notify(`${label} failed: ${e.message}`, "error");
    return;
  }
  const podcast = await pickFromList(
    podcasts,
    (p) => `${p.title}${p.author ? ` (${p.author})` : ""}`,
    label,
    ctx,
  );
  if (!podcast) return;

  // show_notes endpoint is public — no auth needed for episode lists
  let episodes: Episode[];
  try {
    episodes = await getPodcastEpisodes(podcast.uuid, { title: podcast.title, author: podcast.author });
  } catch (e: any) {
    ctx.ui.notify(`Couldn't load episodes: ${e.message}`, "error");
    return;
  }
  const episode = await pickFromList(
    episodes,
    (e) => `${e.title}  [${formatTime(e.duration)}]`,
    podcast.title,
    ctx,
  );
  if (episode) await play(episode, ctx);
}

async function mainMenu(ctx: ExtensionContext): Promise<void> {
  const SUBSCRIPTIONS = "📚 Subscriptions";
  const NEW = "🆕 New releases";
  const CONTINUE = "⏯  Continue listening";
  const SEARCH = "🔎 Search";
  const TRENDING = "📈 Trending";
  const POPULAR = "🔥 Popular";
  const FEATURED = "⭐ Featured";
  const NOW = "ℹ️  Now playing";
  const STOP = "⏹  Stop";
  const AUTH = pc?.isAuthed ? "🚪 Logout" : "🔐 Login";

  const opts = [SUBSCRIPTIONS, NEW, CONTINUE, SEARCH, TRENDING, POPULAR, FEATURED, NOW, STOP, AUTH];
  const choice = await ctx.ui.select("Podcasts", opts);
  if (!choice) return;

  switch (choice) {
    case AUTH:
      if (pc?.isAuthed) {
        await pc.logout();
        ctx.ui.notify("Logged out.", "info");
      } else {
        await loginFlow(ctx);
      }
      break;
    case SUBSCRIPTIONS: await subsFlow(ctx); break;
    case NEW: await newReleasesFlow(ctx); break;
    case CONTINUE: await inProgressFlow(ctx); break;
    case SEARCH: await searchFlow(ctx); break;
    case TRENDING: await listFlow("trending", "Trending", ctx); break;
    case POPULAR: await listFlow("popular", "Popular", ctx); break;
    case FEATURED: await listFlow("featured", "Featured", ctx); break;
    case NOW:
      ctx.ui.notify(
        nowPlaying
          ? `Now playing: ${labelEpisode(nowPlaying)} [${formatTime(currentPosition)}/${formatTime(nowPlaying.duration)}]`
          : "Nothing playing.",
        "info",
      );
      break;
    case STOP:
      flushPosition(3);
      stop();
      clearWidget(ctx);
      ctx.ui.notify("Podcast stopped.", "info");
      break;
  }
}

// ── command registration ───────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // Init the client on load (rehydrates from keychain/file)
  pc = new PocketCastsClient();
  pc.init(); // fire-and-forget — will be loaded by the time user opens menu

  pi.registerCommand("podcast", {
    description:
      "Pocket Casts podcast player. Subcommands: login|logout|subs|new|continue|search|trending|popular|featured|pause|resume|stop|now|ff|rew|seek",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Podcast extension needs an interactive UI.", "warning");
        return;
      }

      const raw = (args || "").trim();
      const [sub, ...rest] = raw.split(/\s+/);
      const arg = rest.join(" ").trim();

      switch (sub.toLowerCase()) {
        case "":
          await mainMenu(ctx);
          break;

        case "login":
          await loginFlow(ctx);
          break;

        case "logout":
          if (pc?.isAuthed) {
            await pc.logout();
            ctx.ui.notify("Logged out.", "info");
          } else {
            ctx.ui.notify("Not logged in.", "info");
          }
          break;

        case "subs":
        case "subscriptions":
          await subsFlow(ctx);
          break;

        case "new":
        case "releases":
          await newReleasesFlow(ctx);
          break;

        case "continue":
        case "resume":
        case "inprogress":
          await inProgressFlow(ctx);
          break;

        case "search":
          await searchFlow(ctx, arg || undefined);
          break;

        case "trending":
          await listFlow("trending", "Trending", ctx);
          break;

        case "popular":
          await listFlow("popular", "Popular", ctx);
          break;

        case "featured":
          await listFlow("featured", "Featured", ctx);
          break;

        case "now":
          if (nowPlaying) {
            ctx.ui.notify(
              `Now playing: ${labelEpisode(nowPlaying)} [${formatTime(currentPosition)}/${formatTime(nowPlaying.duration)}] ${isPaused ? "(paused)" : ""}`,
              "info",
            );
          } else {
            ctx.ui.notify("Nothing playing.", "info");
          }
          break;

        case "pause":
          if (!nowPlaying) { ctx.ui.notify("Nothing playing.", "info"); break; }
          if (isPaused) { ctx.ui.notify("Already paused.", "info"); break; }
          await pausePlayback(ctx);
          ctx.ui.notify(`Paused at ${formatTime(currentPosition)}.`, "info");
          break;

        case "resume":
        case "unpause":
          if (!nowPlaying) { ctx.ui.notify("Nothing playing.", "info"); break; }
          if (!isPaused) { ctx.ui.notify("Already playing.", "info"); break; }
          await resumePlayback(ctx);
          ctx.ui.notify("Resumed.", "info");
          break;

        case "stop":
          await flushPosition(3);
          stop();
          clearWidget(ctx);
          ctx.ui.notify("Podcast stopped.", "info");
          break;

        case "ff":
        case "forward":
          await skipForward(ctx);
          ctx.ui.notify(`Seeked +30s → ${formatTime(currentPosition)}.`, "info");
          break;

        case "rew":
        case "rewind":
          await skipBack(ctx);
          ctx.ui.notify(`Seeked -15s → ${formatTime(currentPosition)}.`, "info");
          break;

        case "seek":
          const sec = parseFloat(arg);
          if (isNaN(sec)) {
            ctx.ui.notify("Usage: /podcast seek <seconds>", "warning");
            break;
          }
          await seekPlayback(sec, ctx);
          ctx.ui.notify(`Seeked by ${sec}s → ${formatTime(currentPosition)}.`, "info");
          break;

        case "position":
        case "pos":
          if (nowPlaying) {
            ctx.ui.notify(
              `Position: ${formatTime(currentPosition)} / ${formatTime(nowPlaying.duration)}`,
              "info",
            );
          } else {
            ctx.ui.notify("Nothing playing.", "info");
          }
          break;

        default:
          ctx.ui.notify(
            "Usage: /podcast [login|logout|subs|new|continue|search <q>|trending|popular|featured|pause|resume|stop|now|ff|rew|seek <s>|position]",
            "info",
          );
          await mainMenu(ctx);
      }
    },
  });

  // ── cleanup ──
  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    if (nowPlaying) {
      await flushPosition(3);
    }
    stop();
    clearWidget(ctx);
  });
}

// Self-check: run node podcast-check.ts to verify Pocket Casts public API.
