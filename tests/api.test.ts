// API-layer tests. Drive the extension through stubbed `globalThis.fetch` to
// verify login and refresh error paths, plus subscription and episode
// parsing. The harness redirects @napi-rs/keyring to a throwing stub, so
// the file fallback handles tokens — but every test that needs authed state
// resets `pc.tokens` explicitly via the login handler before exercising
// the authed path, so test order can't leak state.
import "./harness.ts";

import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let handler: ((args: string, ctx: any) => Promise<void>) | undefined;

before(async () => {
  const fakePi = {
    registerCommand(_name: string, def: { handler: any }) {
      handler = def.handler;
    },
    on(_event: string, _fn: any) {},
  } as unknown as ExtensionAPI;
  const mod = await import("../podcast.ts");
  mod.default(fakePi);
  if (!handler) throw new Error("handler not captured");
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeCtx(opts: { inputs?: (string | undefined)[]; selects?: (string | undefined)[] } = {}) {
  const state = {
    notifications: [] as { msg: string; severity: string }[],
    selects: [] as { title: string; opts: string[] }[],
    inputs: [] as { title: string; placeholder: string }[],
  };
  const inputQueue = [...(opts.inputs ?? [])];
  const selectQueue = [...(opts.selects ?? [])];
  return {
    state,
    hasUI: true,
    ui: {
      notify(msg: string, severity: string) {
        state.notifications.push({ msg, severity });
      },
      async select(title: string, items: string[]) {
        state.selects.push({ title, opts: items });
        return selectQueue.shift();
      },
      async input(title: string, placeholder: string) {
        state.inputs.push({ title, placeholder });
        return inputQueue.shift();
      },
      setWidget() {},
    },
  };
}

type Responder = (url: string, init?: any) => Response | Promise<Response>;

function makeFetch(handlers: Array<{ match: string | RegExp; respond: Responder }>) {
  return async (url: string | URL | Request, init?: any): Promise<Response> => {
    const u = String(url);
    for (const h of handlers) {
      const ok = typeof h.match === "string" ? u.includes(h.match) : h.match.test(u);
      if (ok) return await h.respond(u, init);
    }
    return new Response("{}", { status: 404 });
  };
}

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// JWT-shaped token so pc.email can decode the `sub` claim. The signature
// is not validated by the extension — it just needs to look like
// header.payload.signature with base64url-encoded JSON in the middle.
function fakeJwt(sub: string): string {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

let origFetch: typeof globalThis.fetch;
afterEach(() => {
  if (origFetch) globalThis.fetch = origFetch;
});

// ── login ──────────────────────────────────────────────────────────────────

test("login: success stores tokens and logs out cleanly", async () => {
  origFetch = globalThis.fetch;
  globalThis.fetch = makeFetch([
    {
      match: "/user/login_pocket_casts",
      respond: () => jsonResponse({ accessToken: fakeJwt("user@example.com"), refreshToken: "ref", expiresIn: 3600 }),
    },
  ]) as any;

  const ctx = makeCtx({ inputs: ["user@example.com", "pw"] });
  await handler!("login", ctx);

  assert.equal(ctx.state.notifications.at(-1)?.msg, "Logged in as user@example.com");
  assert.equal(ctx.state.notifications.at(-1)?.severity, "info");

  // After login, logout must say "Logged out." — if login hadn't actually
  // set pc.tokens, logout would say "Not logged in." instead.
  const ctx2 = makeCtx();
  await handler!("logout", ctx2);
  assert.equal(ctx2.state.notifications.at(-1)?.msg, "Logged out.");
});

test("login: token file written to HOME/.config/pi/podcast.json", async () => {
  origFetch = globalThis.fetch;
  globalThis.fetch = makeFetch([
    {
      match: "/user/login_pocket_casts",
      respond: () => jsonResponse({ accessToken: fakeJwt("u@example.com"), refreshToken: "ref-1", expiresIn: 3600 }),
    },
  ]) as any;

  const ctx = makeCtx({ inputs: ["u@example.com", "p"] });
  await handler!("login", ctx);

  const fs = await import("node:fs");
  const path = await import("node:path");
  const tokenFile = path.join(process.env.HOME!, ".config", "pi", "podcast.json");
  assert.ok(fs.existsSync(tokenFile), `expected token file at ${tokenFile}`);
  const stored = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  assert.equal(stored.accessToken, fakeJwt("u@example.com"));
  assert.equal(stored.refreshToken, "ref-1");
  assert.ok(typeof stored.expiresAt === "number" && stored.expiresAt > Date.now());
});

// ── refresh failure ────────────────────────────────────────────────────────

test("refresh failure: expired token clears pc.tokens and notifies the user", async () => {
  // Drive a login with a token that's valid for one second, then wait for it
  // to expire, then call an authed method.
  origFetch = globalThis.fetch;
  globalThis.fetch = makeFetch([
    {
      match: "/user/login_pocket_casts",
      respond: () => jsonResponse({ accessToken: fakeJwt("u@example.com"), refreshToken: "ref", expiresIn: 1 }),
    },
    {
      // Refresh endpoint always fails.
      match: "/user/token",
      respond: () => jsonResponse({ message: "invalid_grant" }, 400),
    },
  ]) as any;

  const loginCtx = makeCtx({ inputs: ["u@example.com", "p"] });
  await handler!("login", loginCtx);

  // Wait for the token to enter the "needs refresh" window (within 60s of
  // expiry). expiresIn is 1, so the token's expiresAt is ~now+1000ms. The
  // 60s slack in ensureToken means we have to actually wait past expiresAt
  // for refresh to fire.
  await new Promise((r) => setTimeout(r, 1100));

  // Now drive an authed command — getSubscriptions via /podcast subs.
  const subsCtx = makeCtx({ selects: [undefined] });
  await handler!("subs", subsCtx);

  // Expected: either the refresh failure was caught at the authedPost layer
  // (notify "Failed: Token refresh failed. Run /podcast login.") OR the
  // ensureToken throw surfaced as a "Failed:" notify. Both are acceptable —
  // what's NOT acceptable is NEEDS_PLUS (pc.tokens wasn't cleared) or a
  // hang.
  const notif = subsCtx.state.notifications.at(-1);
  assert.ok(notif, "expected a notification from the refresh-failure path");
  assert.notEqual(notif.msg, "Needs Pocket Casts Plus. Log in with /podcast login — or browse Trending, Popular and Featured, which work without an account.",
    "pc.tokens should have been cleared by the failed refresh");

  // After a failed refresh, /podcast logout must report "Not logged in." —
  // proving pc.tokens was cleared.
  const logoutCtx = makeCtx();
  await handler!("logout", logoutCtx);
  assert.equal(logoutCtx.state.notifications.at(-1)?.msg, "Not logged in.");
});

// ── subscription parsing ───────────────────────────────────────────────────

test("subscription parsing: getSubscriptions parses podcasts into the picker", async () => {
  origFetch = globalThis.fetch;
  globalThis.fetch = makeFetch([
    {
      match: "/user/login_pocket_casts",
      respond: () => jsonResponse({ accessToken: fakeJwt("u@example.com"), refreshToken: "ref", expiresIn: 3600 }),
    },
    {
      match: "/user/podcast/list",
      respond: () => jsonResponse({
        podcasts: [
          { uuid: "p1", title: "Lex Fridman", author: "Lex Fridman" },
          { uuid: "p2", title: "Huberman Lab", author: "Andrew Huberman" },
        ],
      }),
    },
  ]) as any;

  // Log in, then drive /podcast subs. The user picks "Huberman Lab" via the
  // picker (which then tries to load episodes — that fetch returns 404 by
  // default, which surfaces as "Couldn't load episodes" — but the picker
  // labels are what we're asserting).
  await handler!("login", makeCtx({ inputs: ["u@example.com", "p"] }));
  const ctx = makeCtx({ selects: ["Huberman Lab (Andrew Huberman)", undefined] });
  await handler!("subs", ctx);

  const firstSelect = ctx.state.selects[0];
  assert.equal(firstSelect?.title, "Your subscriptions");
  assert.deepEqual(firstSelect?.opts, ["Lex Fridman (Lex Fridman)", "Huberman Lab (Andrew Huberman)"]);
});

// ── episode parsing ────────────────────────────────────────────────────────

test("episode parsing: show_notes responses are mapped into the Episode shape", async () => {
  // listFlow doesn't need auth — show_notes is public. Drive /podcast
  // trending, pick a podcast, and verify the show_notes response is parsed
  // into episode rows for the picker.
  origFetch = globalThis.fetch;
  globalThis.fetch = makeFetch([
    {
      match: "lists.pocketcasts.com/trending.json",
      respond: () => jsonResponse({
        podcasts: [
          { uuid: "p1", title: "Some Podcast", author: "Author", feed: "https://example.com/feed.xml" },
        ],
      }),
    },
    {
      match: "/show_notes/full/p1",
      respond: () => jsonResponse({
        podcast: {
          title: "Some Podcast",
          author: "Author",
          episodes: [
            { uuid: "e1", title: "Episode 1", url: "https://example.com/e1.mp3", published: "2024-01-01", duration: 1800 },
            { uuid: "e2", title: "Episode 2", url: "https://example.com/e2.mp3", published: "2024-01-08", duration: 2400 },
          ],
        },
      }),
    },
  ]) as any;

  // trending flow: select "Some Podcast (Author)" (the picker labels include
  // the author in parens), then pick an episode (which would call play() —
  // we cancel via undefined).
  const ctx = makeCtx({ selects: ["Some Podcast (Author)", undefined] });
  await handler!("trending", ctx);

  // The second select is the episode picker (titles + "[MM:SS]").
  const episodeSelect = ctx.state.selects[1];
  assert.ok(episodeSelect, "expected an episode select after the trending pick");
  assert.equal(episodeSelect.title, "Some Podcast");
  assert.deepEqual(episodeSelect.opts, [
    "Episode 1  [30:00]",
    "Episode 2  [40:00]",
  ]);
});

// ── keyring fallback (#15) ──────────────────────────────────────────────────
//
// Two scenarios must round-trip tokens through the file:
//   - keyring "missing" (constructor throws): simulates a system with no
//     credential manager or a keyring that's been uninstalled.
//   - keyring "broken" (constructor OK, methods throw): simulates a locked
//     store on @napi-rs/keyring 2.x — the kind of failure the ticket
//     describes that the pre-fix code surfaced instead of catching.

import { saveTokens, loadTokens } from "../podcast.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const KEYRING_ENV = "PI_PODCAST_KEYRING_STUB";

function withKeyringMode(mode: "missing" | "broken", fn: () => Promise<void>) {
  return async () => {
    const prev = process.env[KEYRING_ENV];
    process.env[KEYRING_ENV] = mode;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env[KEYRING_ENV];
      else process.env[KEYRING_ENV] = prev;
    }
  };
}

function tokenFile() {
  return path.join(process.env.HOME!, ".config", "pi", "podcast.json");
}

test("keyring missing: login still writes tokens to the file fallback", withKeyringMode("missing", async () => {
  origFetch = globalThis.fetch;
  globalThis.fetch = makeFetch([
    {
      match: "/user/login_pocket_casts",
      respond: () => jsonResponse({ accessToken: fakeJwt("missing@example.com"), refreshToken: "ref", expiresIn: 3600 }),
    },
  ]) as any;

  const ctx = makeCtx({ inputs: ["missing@example.com", "p"] });
  await handler!("login", ctx);

  // Login notify still fires — saveTokens caught the constructor throw.
  assert.equal(ctx.state.notifications.at(-1)?.msg, "Logged in as missing@example.com");
  // And the file fallback now holds the tokens.
  assert.ok(fs.existsSync(tokenFile()), `expected token file at ${tokenFile()}`);
}));

test("keyring missing: loadTokens falls through to the file when getPassword throws (constructor)", withKeyringMode("missing", async () => {
  // Save tokens directly so the file has them; default-mode constructor
  // would otherwise block the file write.
  process.env[KEYRING_ENV] = "missing";
  const saved = { accessToken: "file-tok", refreshToken: "file-ref", expiresAt: Date.now() + 3600000 };
  await saveTokens(saved);
  // Sanity: the file actually has them.
  assert.ok(fs.existsSync(tokenFile()));
  const onDisk = JSON.parse(fs.readFileSync(tokenFile(), "utf8"));
  assert.equal(onDisk.accessToken, "file-tok");

  // loadTokens in missing mode: Entry constructor throws. With the fix,
  // the catch falls through to the file read.
  const loaded = await loadTokens();
  assert.ok(loaded, "loadTokens must return the file tokens, not null");
  assert.equal(loaded!.accessToken, "file-tok");
}));

test("keyring broken: login still writes tokens to the file fallback", withKeyringMode("broken", async () => {
  origFetch = globalThis.fetch;
  globalThis.fetch = makeFetch([
    {
      match: "/user/login_pocket_casts",
      respond: () => jsonResponse({ accessToken: fakeJwt("broken@example.com"), refreshToken: "ref", expiresIn: 3600 }),
    },
  ]) as any;

  const ctx = makeCtx({ inputs: ["broken@example.com", "p"] });
  await handler!("login", ctx);

  // Login notify still fires — saveTokens caught the setPassword throw.
  assert.equal(ctx.state.notifications.at(-1)?.msg, "Logged in as broken@example.com");
  assert.equal(ctx.state.notifications.at(-1)?.severity, "info");
  // And the file fallback now holds the tokens.
  assert.ok(fs.existsSync(tokenFile()), `expected token file at ${tokenFile()}`);
  const onDisk = JSON.parse(fs.readFileSync(tokenFile(), "utf8"));
  assert.equal(onDisk.accessToken, fakeJwt("broken@example.com"));
}));

test("keyring broken: loadTokens falls through to the file when getPassword throws", withKeyringMode("broken", async () => {
  // Save tokens directly so the file has them, then verify loadTokens
  // reads them despite the broken-mode getPassword throw.
  const saved = { accessToken: "file-tok-2", refreshToken: "file-ref-2", expiresAt: Date.now() + 3600000 };
  await saveTokens(saved);
  assert.ok(fs.existsSync(tokenFile()));

  const loaded = await loadTokens();
  assert.ok(loaded, "loadTokens must return the file tokens, not null");
  assert.equal(loaded!.accessToken, "file-tok-2");
}));
