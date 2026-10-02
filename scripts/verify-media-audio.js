#!/usr/bin/env node
// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../src-tauri/module/media-audio.js", import.meta.url), "utf8");
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 8; i++) await turn(); }

function harness({ codec = "eac3", probe, start, read, subtitleTracks = [], subtitleRead } = {}) {
  const calls = [], timers = new Map(), contexts = [], messages = [];
  let sequence = 0, timerSequence = 0, video;
  class Media extends EventTarget {
    constructor(url) {
      super();
      this.src = url;
      this.paused = false;
      this.currentTime = 0;
      this.playbackRate = 1;
      this.volume = 0.7;
      this.nativeMuted = false;
      this.seeking = false;
    }
    addTextTrack() {
      const track = { cues: [], mode: "disabled", addCue(cue) { this.cues.push(cue); }, removeCue(cue) { this.cues.splice(this.cues.indexOf(cue), 1); } };
      this.textTracks = [track];
      return track;
    }
    get muted() { return this.nativeMuted; }
    set muted(value) { this.nativeMuted = value; }
    getAttribute(name) { return this[name]; }
    pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
    play() {
      this.paused = false;
      queueMicrotask(() => {
        this.dispatchEvent(new Event("play"));
        this.dispatchEvent(new Event("playing"));
      });
      return Promise.resolve();
    }
  }
  class Context {
    constructor() { this.currentTime = 0; this.state = "running"; this.sources = []; this.destination = { maxChannelCount: 8 }; contexts.push(this); }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    createBuffer(channels, frames, rate) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return { numberOfChannels: channels, duration: frames / rate, getChannelData: (channel) => data[channel] };
    }
    createBufferSource() {
      const source = {
        playbackRate: { value: 1 }, connect() {}, disconnect() {},
        start(when, offset) { this.started = { when, offset }; },
        stop() { this.stopped = true; },
      };
      this.sources.push(source);
      return source;
    }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  const player = {
    url(url) { video = new Media(url); return "native result"; },
    destroy() { return "destroy result"; },
    video: () => video,
    saveParams: () => ({}),
    listener: { send(type, data) { messages.push({ type, data }); } },
  };
  const window = new EventTarget();
  window.AudioContext = Context;
  window.Prisma = { PlayerVideo: player, Noty: { show(message) { messages.push({ type: "error", message }); } } };
  const sessions = new Map();
  window.__TAURI__ = { core: { async invoke(name, args) {
    calls.push({ name, ...args });
    if (name === "media_subtitle_tracks") return subtitleTracks;
    if (name === "media_subtitle_start") return ++sequence;
    if (name === "media_subtitle_read") return subtitleRead(args);
    if (name === "media_audio_probe") return probe ? probe() : [
      { index: 2, codec, title: "Русский", language: "rus", channels: 6, default: true },
      { index: 5, codec: "ac3", title: "Original", language: "eng", channels: 2 },
    ];
    if (name === "media_audio_start") {
      const id = start ? await start(args) : ++sequence;
      sessions.set(id, args.channels);
      return id;
    }
    if (name === "media_audio_read") {
      if (read) return read(args);
      const channels = sessions.get(args.id);
      const pcm = new Float32Array(24000 * channels);
      for (let i = 0; i < pcm.length; i += channels) { pcm[i] = 0.25; pcm[i + 1] = -0.5; }
      return pcm.buffer;
    }
  } } };
  vm.runInNewContext(script, {
    window, document: new EventTarget(), location: { href: "https://prisma.ws" },
    HTMLMediaElement: Media, URL, ArrayBuffer, Uint8Array, DataView, Date, Event, TextDecoder, VTTCue: class { constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); } },
    setInterval(handler) { const id = ++timerSequence; timers.set(id, handler); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  return {
    player, calls, contexts, messages, window, video: () => video,
    async tick() { for (const handler of [...timers.values()]) handler(); await settle(); },
  };
}

{
  const h = harness();
  assert.equal(h.player.url("http://localhost:8090/stream?play&index=0"), "native result");
  await settle();
  const video = h.video(), context = h.contexts[0];
  assert.equal(h.calls.filter((call) => call.name === "media_audio_read").length, 12, "PCM lookahead fills without waiting for timer ticks");
  assert.equal(video.nativeMuted, true);
  assert.equal(video.muted, false);
  assert.equal(video.audioTracks[0].enabled, true);
  assert.equal(h.messages.find((m) => m.type === "tracks").data.tracks.length, 2);
  await h.tick();
  assert.ok(context.sources[0].started);
  assert.equal(context.sources[0].buffer.getChannelData(0)[10], 0.25);
  assert.equal(context.sources[0].buffer.getChannelData(1)[10], -0.5);
  assert.equal(context.sources[0].buffer.numberOfChannels, 6);
  assert.equal(context.destination.channelCount, 6);
  video.muted = true;
  assert.equal(video.nativeMuted, true);
  video.muted = false;
  assert.equal(video.nativeMuted, true);

  video.pause();
  await settle();
  assert.ok(context.sources.every((s) => s.stopped));
  assert.ok(h.calls.some((c) => c.name === "media_audio_stop" && c.id === 1));
  const reads = h.calls.filter((c) => c.name === "media_audio_read").length;
  await h.tick();
  assert.equal(h.calls.filter((c) => c.name === "media_audio_read").length, reads);
  video.currentTime = 12.25;
  await video.play();
  await settle();
  assert.equal(h.calls.filter((c) => c.name === "media_audio_start").at(-1).start, 12.25);

  video.currentTime = 35.5;
  video.dispatchEvent(new Event("seeking"));
  await settle();
  assert.equal(h.calls.filter((c) => c.name === "media_audio_start").at(-1).start, 35.5);
  video.audioTracks[1].enabled = true;
  await settle();
  assert.equal(h.calls.filter((c) => c.name === "media_audio_start").at(-1).stream, 5);
  assert.equal(video.audioTracks[0].enabled, false);
  assert.equal(video.audioTracks[1].enabled, true);
  await h.tick();
  video.playbackRate = 1.5;
  video.dispatchEvent(new Event("ratechange"));
  await settle();
  await h.tick();
  assert.equal(context.sources.at(-1).playbackRate.value, 1);
  assert.equal(h.calls.filter((c) => c.name === "media_audio_start").at(-1).rate, 1.5);
  assert.equal(h.player.destroy(), "destroy result");
  await settle();
  assert.equal(video.nativeMuted, false);
  assert.equal(Object.hasOwn(video, "muted"), false);
  assert.equal(Object.hasOwn(video, "audioTracks"), false);
  assert.equal(context.state, "closed");
  assert.equal(h.window.__prismaMediaAudio.status().active, false);
}

// Native AAC playback, playlists and failed probes must remain usable.
for (const options of [
  { probe: () => [{ index: 1, codec: "aac", default: true }] },
  { probe: () => Promise.reject("unsupported container") },
]) {
  const h = harness(options);
  h.player.url("https://host/movie.mp4");
  await settle();
  assert.equal(h.video().nativeMuted, false);
  assert.ok(!h.calls.some((c) => c.name === "media_audio_start"));
}
{
  const h = harness();
  for (const url of ["https://host/live.m3u8?token=1", "https://host/live.mpd", "blob:https://host/abc"]) h.player.url(url);
  await settle();
  assert.equal(h.calls.length, 0);
}

// Replacing/closing a player while a probe or a native start is in flight must
// neither mutate the retired element nor leak its decoder into the next video.
{
  let resolve;
  const h = harness({ probe: () => new Promise((done) => { resolve = done; }) });
  h.player.url("https://host/old.mkv");
  h.player.destroy();
  resolve([{ index: 1, codec: "ac3" }]);
  await settle();
  assert.equal(h.video().nativeMuted, false);
  assert.equal(h.contexts.length, 0);
}
{
  let release;
  let sequence = 0;
  const h = harness({ start: async () => {
    if (++sequence === 1) return new Promise((resolve) => { release = resolve; });
    return sequence;
  } });
  h.player.url("https://host/old.mkv");
  await settle();
  const retired = h.video();
  h.player.url("https://host/new.mkv");
  await settle();
  release(1);
  await settle();
  assert.equal(retired.nativeMuted, false);
  assert.ok(h.calls.some((c) => c.name === "media_audio_stop" && c.id === 1));
  assert.ok(h.calls.some((c) => c.name === "media_audio_read" && c.id === 2));
  h.player.destroy();
}
{
  const h = harness({ read: () => Promise.reject("Decode failed") });
  h.player.url("https://host/broken.mkv");
  await settle();
  assert.equal(h.video().nativeMuted, false);
  assert.equal(h.window.__prismaMediaAudio.status().active, false);
  assert.equal(h.contexts[0].state, "closed");
  assert.ok(h.messages.some((m) => m.type === "error"));
}
{
  const h = harness();
  h.player.url("https://host/movie.mkv");
  await settle();
  for (let i = 0; i < 100; i++) await h.tick();
  assert.equal(h.calls.filter((c) => c.name === "media_audio_read").length, 12, "PCM must stop prefetching after six seconds");
  h.contexts[0].state = "suspended";
  await h.tick();
  assert.equal(h.video().paused, true, "wait for an audible AudioContext");
  assert.ok(h.contexts[0].sources.every((s) => s.stopped));
  h.contexts[0].state = "running";
  await h.tick();
  assert.equal(h.video().paused, false);
  h.player.destroy();
}
{
  let end;
  const h = harness({ read: () => new Promise((resolve) => { end = resolve; }) });
  h.player.url("https://host/short-audio.mkv");
  await settle();
  await h.tick();
  assert.equal(h.video().paused, true);
  end(new ArrayBuffer(0));
  await settle();
  await h.tick();
  assert.equal(h.video().paused, false, "audio EOF must release a buffering pause");
  assert.equal(h.calls.filter((c) => c.name === "media_audio_start").length, 1);
  h.player.destroy();
}
{
  let reject;
  const h = harness({ read: () => new Promise((_, fail) => { reject = fail; }) });
  h.player.url("https://host/broken-audio.mkv");
  await settle();
  await h.tick();
  assert.equal(h.video().paused, true);
  reject("Decode timeout");
  await settle();
  assert.equal(h.video().paused, false, "decode failure must restore native playback");
  assert.equal(h.video().nativeMuted, false);
  assert.equal(h.contexts[0].state, "closed");
}
{
  const h = harness({ read: () => new Promise(() => {}) });
  h.player.url("https://host/buffering.mkv");
  await settle();
  await h.tick();
  const retired = h.video();
  assert.equal(retired.paused, true);
  h.player.destroy();
  await settle();
  assert.equal(retired.paused, true, "closing the player must not restart a retired video");
}
console.log("FFmpeg audio: PCM/multichannel, pause/resume, seek, tracks, speed, mute, bounded buffers, failures/EOF, teardown and stale requests passed");

{
  const data = new TextEncoder().encode("WEBVTT\n\n00:00.100 --> 00:03.000\nПривет\n\n");
  let part = 0;
  const h = harness({ subtitleTracks: [{ index: 9, codec: "subrip", language: "rus", title: "Русские" }],
    subtitleRead: () => [data.slice(0, 48).buffer, data.slice(48).buffer, new ArrayBuffer(0)][part++] || new ArrayBuffer(0) });
  h.player.url("https://example.com/movie.mkv");
  await settle();
  const video = h.video(), rendered = [];
  video.addEventListener("subtitle", (event) => rendered.push(event.text));
  assert.equal(video.customSubs.length, 1);
  assert.ok(h.messages.some((message) => message.type === "subs"));
  video.customSubs[0].mode = "showing";
  await settle();
  video.currentTime = 1;
  video.dispatchEvent(new Event("timeupdate"));
  assert.equal(rendered.at(-1), "Привет");
  assert.equal(video.textTracks[0].cues.length, 1);
  assert.equal(video.textTracks[0].cues[0].startTime, 0.1);
  video.currentTime = 4;
  video.dispatchEvent(new Event("timeupdate"));
  assert.equal(rendered.at(-1), "");
  video.currentTime = 200;
  video.dispatchEvent(new Event("seeking"));
  await settle();
  assert.ok(h.calls.some((call) => call.name === "media_subtitle_start" && call.stream === 9 && call.start === 185));
  video.customSubs[0].mode = "disabled";
  assert.equal(video.textTracks[0].cues.length, 0);
  h.player.destroy();
  assert.equal(video.customSubs, undefined);
}
console.log("Embedded subtitles: UTF-8 chunks, menu, timeline, seek, off and teardown passed");
