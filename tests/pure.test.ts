// Pure-function tests for the helpers exported from podcast.ts.
// Imports the harness so the pi peer-import stubs are registered before
// podcast.ts is loaded.
import "./harness.ts";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatTime,
  listeningPct,
  progressBar,
  widgetText,
  finishStatus,
} from "../podcast.ts";

const sampleEpisode = {
  uuid: "u",
  title: "Episode 1",
  url: "https://example.com/audio.mp3",
  podcastUuid: "p",
  podcastTitle: "A Podcast",
  published: "2024-01-01",
  duration: 1800,
  playedUpTo: 0,
};

// ── formatTime ─────────────────────────────────────────────────────────────

test("formatTime: zero and negative are clamped to 0:00", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(-5), "0:00");
});

test("formatTime: under a minute", () => {
  assert.equal(formatTime(1), "0:01");
  assert.equal(formatTime(59), "0:59");
});

test("formatTime: minutes:seconds", () => {
  assert.equal(formatTime(60), "1:00");
  assert.equal(formatTime(125), "2:05");
  assert.equal(formatTime(3599), "59:59");
});

test("formatTime: hours:minutes:seconds", () => {
  assert.equal(formatTime(3600), "1:00:00");
  assert.equal(formatTime(3725), "1:02:05");
  assert.equal(formatTime(7325), "2:02:05");
});

// ── listeningPct ───────────────────────────────────────────────────────────

test("listeningPct: integer percent, clamped to [0,100]", () => {
  assert.equal(listeningPct(0, 100), 0);
  assert.equal(listeningPct(50, 100), 50);
  assert.equal(listeningPct(100, 100), 100);
  assert.equal(listeningPct(150, 100), 100);
  assert.equal(listeningPct(-10, 100), 0);
});

test("listeningPct: rounds half to nearest", () => {
  assert.equal(listeningPct(33.4, 100), 33);
  assert.equal(listeningPct(33.5, 100), 34);
});

test("listeningPct: zero duration is 0 (avoids divide-by-zero)", () => {
  assert.equal(listeningPct(0, 0), 0);
  assert.equal(listeningPct(100, 0), 0);
});

// ── progressBar ────────────────────────────────────────────────────────────

test("progressBar: 0% is all empty blocks", () => {
  assert.equal(progressBar(0, 5), "░░░░░");
});

test("progressBar: 100% is all filled blocks", () => {
  assert.equal(progressBar(100, 5), "█████");
});

test("progressBar: 50% of width 4 rounds to two filled", () => {
  assert.equal(progressBar(50, 4), "██░░");
});

test("progressBar: width of 0 or negative clamps to 1", () => {
  assert.equal(progressBar(50, 0).length, 1);
  assert.equal(progressBar(50, -3).length, 1);
});

// ── widgetText ─────────────────────────────────────────────────────────────

test("widgetText: short label fits and shows the play marker", () => {
  const text = widgetText(sampleEpisode, 80, 900, false);
  assert.ok(text.length <= 80, `length ${text.length} exceeds 80`);
  assert.ok(text.includes("50%"), `expected "50%" in ${JSON.stringify(text)}`);
  assert.ok(text.includes("▶"), `expected "▶" in ${JSON.stringify(text)}`);
});

test("widgetText: paused marker is shown when isPaused", () => {
  const text = widgetText(sampleEpisode, 80, 0, true);
  assert.ok(text.includes("⏸"));
  assert.ok(text.includes("0%"));
});

test("widgetText: long label truncates with ellipsis to fit", () => {
  const ep = {
    ...sampleEpisode,
    title: "A".repeat(200),
    podcastTitle: "B".repeat(200),
  };
  const text = widgetText(ep, 60, 0, false);
  assert.ok(text.length <= 60, `length ${text.length} exceeds 60: ${JSON.stringify(text)}`);
  assert.ok(text.includes("…"), `expected ellipsis in ${JSON.stringify(text)}`);
});

test("widgetText: percent and marker survive any width", () => {
  // The bar is fixed-width (20), so for narrow widths the line overflows by
  // design — the terminal clips/wraps. What matters is that the percent
  // and the play/pause marker are still emitted, so even a clipped line
  // tells the user where they are.
  const text = widgetText(sampleEpisode, 20, 900, false);
  assert.ok(text.includes("50%"));
  assert.ok(text.includes("▶"));
});

// ── finishStatus ───────────────────────────────────────────────────────────

test("finishStatus: endReason eof is always finished (status 3)", () => {
  assert.equal(finishStatus("eof", 0, sampleEpisode), 3);
  assert.equal(finishStatus("eof", 1, sampleEpisode), 3);
});

test("finishStatus: position within 5s of duration is finished", () => {
  const ep = { ...sampleEpisode, duration: 100 };
  assert.equal(finishStatus(null, 95, ep), 3);
  assert.equal(finishStatus(null, 100, ep), 3);
});

test("finishStatus: position before the end is in-progress (status 2)", () => {
  const ep = { ...sampleEpisode, duration: 100 };
  assert.equal(finishStatus(null, 94, ep), 2);
  assert.equal(finishStatus(null, 30, ep), 2);
});

test("finishStatus: null episode is in-progress", () => {
  assert.equal(finishStatus(null, 0, null), 2);
  assert.equal(finishStatus("eof", 0, null), 3); // eof still wins
});

test("finishStatus: zero-duration episode with non-eof is in-progress", () => {
  const ep = { ...sampleEpisode, duration: 0 };
  assert.equal(finishStatus(null, 0, ep), 2);
});

test("finishStatus: stop/quit/error reason is in-progress", () => {
  const ep = { ...sampleEpisode, duration: 1800 };
  for (const reason of ["stop", "quit", "error", null]) {
    assert.equal(finishStatus(reason, 500, ep), 2, `reason=${reason}`);
  }
});