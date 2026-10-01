// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
// SPDX-License-Identifier: AGPL-3.0-only

(function () {
  "use strict";
  if (window.__prismaMediaAudio) return;

  const RATE = 48000;
  const invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
  const muteProperty = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted");
  // A delayed start from a retired video must never replace a newer decoder.
  let operations = Promise.resolve();
  let current = null;

  function directMedia(url) {
    try {
      const parsed = new URL(url, location.href);
      return /^https?:$/.test(parsed.protocol) && !/\.(m3u8|mpd)(?:$|[/?])/i.test(parsed.pathname);
    } catch { return false; }
  }

  class AudioBridge {
    constructor(video, url, player) {
      this.video = video;
      this.url = url;
      this.player = player;
      this.disposed = false;
      this.generation = 0;
      this.id = null;
      this.active = false;
      this.intent = !video.paused;
      this.internalPause = false;
      this.stalled = false;
      this.buffers = [];
      this.nodes = new Set();
      this.handlers = [];
      this.track = null;
      this.eof = false;
      this.reading = false;
      this.logicalMuted = video.muted;
      this.oldMuted = Object.getOwnPropertyDescriptor(video, "muted");
      this.oldTracks = Object.getOwnPropertyDescriptor(video, "audioTracks");
      this.listen(video, "playing", () => {
        this.intent = true;
        this.internalPause = false;
        this.stalled = false;
        this.unschedule();
        if (this.active && !this.eof && (!this.id || Date.now() - (this.lastReadAt || 0) > 20000)) this.restart();
      });
      this.listen(video, "play", () => { this.intent = true; this.context?.resume().catch(() => {}); });
      this.listen(video, "pause", () => {
        this.unschedule();
        if (!this.internalPause) {
          this.intent = false;
          this.cancel();
        }
      });
      this.listen(video, "waiting", () => { this.stalled = true; this.unschedule(); });
      this.listen(video, "seeking", () => { if (this.active) this.restart(); });
      this.listen(video, "ratechange", () => { if (this.active) this.restart(); });
      this.listen(video, "volumechange", () => this.volume());
      this.listen(video, "ended", () => { this.intent = false; this.cancel(); });
      this.listen(video, "error", () => this.dispose());
      this.listen(video, "emptied", () => {
        if (video.getAttribute("src") !== url) this.dispose();
      });
      for (const event of ["pointerdown", "keydown"]) {
        this.listen(document, event, () => this.context?.resume().catch(() => {}));
      }
      this.probe();
    }

    listen(target, type, handler) {
      target.addEventListener(type, handler);
      this.handlers.push(() => target.removeEventListener(type, handler));
    }

    async probe() {
      try {
        const tracks = await invoke("media_audio_probe", { url: this.url });
        if (this.disposed || !tracks.some((t) => /^(ac3|eac3)$/.test(t.codec))) return;
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context || !muteProperty) throw new Error("Web Audio недоступен");
        this.context = new Context({ sampleRate: RATE });
        this.gain = this.context.createGain();
        this.gain.connect(this.context.destination);
        const saved = this.player.saveParams?.();
        this.track = tracks[saved?.track] || tracks.find((t) => t.default) || tracks[0];
        this.tracks = tracks.map((track) => {
          const item = {
            index: track.index,
            language: track.language,
            label: track.title || track.language || track.codec.toUpperCase(),
            custom_title: [track.title || track.language, track.codec.toUpperCase(), `${track.channels} Ch`].filter(Boolean).join(" / "),
            selected: track === this.track,
          };
          Object.defineProperty(item, "enabled", {
            get: () => this.track === track,
            set: (enabled) => {
              if (!enabled || this.track === track || this.disposed) return;
              this.track = track;
              this.tracks.forEach((t) => { t.selected = t.index === track.index; });
              this.restart();
            },
          });
          return item;
        });
        this.active = true;
        Object.defineProperty(this.video, "audioTracks", { configurable: true, get: () => this.tracks });
        // Keep the player's mute/volume controls meaningful while the native
        // audio is silenced. A mute click changes the PCM gain, never re-enables
        // a second simultaneous audio decoder in the WebView.
        Object.defineProperty(this.video, "muted", {
          configurable: true,
          get: () => this.logicalMuted,
          set: (value) => { this.logicalMuted = !!value; this.volume(); },
        });
        muteProperty.set.call(this.video, true);
        this.volume();
        this.player.listener.send("tracks", { tracks: this.tracks });
        this.timer = setInterval(() => this.tick(), 40);
        this.context.resume().catch(() => {});
        this.restart();
      } catch (error) {
        if (!this.disposed) {
          // A failed probe is common for live HLS or unsupported containers.
          // Do not interfere with native playback in that case.
          if (this.active || this.context) this.fail(error);
          else this.dispose();
        }
      }
    }

    volume() {
      if (!this.active) this.logicalMuted = this.video.muted;
      if (this.gain) this.gain.gain.value = this.logicalMuted ? 0 : this.video.volume;
    }

    unschedule() {
      for (const node of this.nodes) {
        try { node.stop(); } catch {}
        node.disconnect();
      }
      this.nodes.clear();
      this.anchor = null;
      this.scheduledUntil = -1;
    }

    cancel() {
      this.generation++;
      this.unschedule();
      const id = this.id;
      this.id = null;
      this.buffers = [];
      this.eof = false;
      if (id) invoke("media_audio_stop", { id }).catch(() => {});
    }

    restart() {
      this.cancel();
      if (this.disposed || !this.active || !this.intent) return;
      const generation = this.generation;
      const valid = () => !this.disposed && generation === this.generation;
      operations = operations.catch(() => {}).then(async () => {
        if (!valid()) return;
        const start = Math.max(0, this.video.currentTime || 0);
        this.nextTime = start;
        this.channels = [1, 2, 4, 6, 8].includes(this.track.channels) ? this.track.channels : 2;
        this.rate = this.video.playbackRate || 1;
        const maximum = this.context.destination.maxChannelCount || 2;
        this.context.destination.channelCount = Math.min(this.channels, maximum);
        const id = await invoke("media_audio_start", { url: this.url, stream: this.track.index, start, channels: this.channels, rate: this.rate });
        if (!valid()) {
          await invoke("media_audio_stop", { id });
          return;
        }
        this.id = id;
        this.reading = false;
        this.fill();
      }).catch((error) => { if (valid()) this.fail(error); });
    }

    async fill() {
      if (!this.id || this.reading || this.eof || this.disposed) return;
      // The decoder has its own bounded queue; JS retains at most six seconds.
      if (this.nextTime - this.video.currentTime >= 6 * this.rate) return;
      const id = this.id;
      const generation = this.generation;
      this.reading = true;
      try {
        const raw = await invoke("media_audio_read", { id });
        if (this.disposed || generation !== this.generation) return;
        const bytes = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
        if (bytes.byteLength === 0) { this.eof = true; return; }
        if (bytes.byteLength % (this.channels * 4)) throw new Error("Некорректный PCM-пакет");
        const frames = bytes.byteLength / (this.channels * 4);
        const buffer = this.context.createBuffer(this.channels, frames, RATE);
        const samples = new DataView(bytes);
        for (let channel = 0; channel < this.channels; channel++) {
          const output = buffer.getChannelData(channel);
          for (let i = 0; i < frames; i++) output[i] = samples.getFloat32((i * this.channels + channel) * 4, true);
        }
        this.buffers.push({ start: this.nextTime, end: this.nextTime + frames / RATE * this.rate, buffer });
        this.nextTime += frames / RATE * this.rate;
        this.lastReadAt = Date.now();
      } catch (error) {
        if (generation === this.generation && !this.disposed) this.fail(error);
      } finally {
        if (generation === this.generation) this.reading = false;
      }
    }

    tick() {
      if (!this.active || this.disposed) return;
      this.fill();
      const time = this.video.currentTime;
      const rate = this.video.playbackRate || 1;
      this.buffers = this.buffers.filter((b) => b.end > time - 0.5);
      if (!this.intent || this.video.seeking || this.stalled && !this.internalPause) return;
      const available = this.buffers.some((b) => b.start <= time + 0.005 && b.end > time);
      if (!available || this.context.state !== "running") {
        this.unschedule();
        if (this.eof && this.internalPause) {
          this.internalPause = false;
          this.stalled = false;
          this.video.play().catch(() => { this.intent = false; });
        }
        if (!this.video.paused && !this.eof) {
          this.internalPause = true;
          this.video.pause();
        }
        return;
      }
      if (this.internalPause) {
        this.stalled = false;
        this.video.play().catch(() => { this.internalPause = false; this.intent = false; });
        return;
      }
      if (this.video.paused) return;
      // Both clocks continue independently. Re-anchor after pause, seek, speed
      // changes, buffering, or more than 80ms of clock drift.
      const contextTime = this.context.currentTime;
      if (this.anchor && Math.abs(this.anchor.media + (contextTime - this.anchor.audio) * rate - time) > 0.08) this.unschedule();
      if (!this.anchor) this.anchor = { media: time, audio: contextTime };
      for (const part of this.buffers) {
        if (part.end <= time || part.start < this.scheduledUntil - 0.005 || part.start > time + 1.5 * rate) continue;
        const position = Math.max(time, part.start);
        const node = this.context.createBufferSource();
        node.buffer = part.buffer;
        node.playbackRate.value = 1;
        node.connect(this.gain);
        node.onended = () => { this.nodes.delete(node); node.disconnect(); };
        this.nodes.add(node);
        const when = this.anchor.audio + (position - this.anchor.media) / rate;
        node.start(Math.max(contextTime, when), (position - part.start) / rate);
        this.scheduledUntil = part.end;
      }
    }

    fail(error) {
      const message = typeof error === "string" ? error : error?.message || "Ошибка декодирования аудио";
      // Backend errors omit URLs, credentials and raw FFmpeg diagnostics.
      window.Prisma?.Noty?.show(`FFmpeg: ${message}`);
      this.dispose(true);
    }

    dispose(resumePlayback = false) {
      if (this.disposed) return;
      const resume = resumePlayback && this.internalPause && this.intent;
      this.disposed = true;
      this.cancel();
      clearInterval(this.timer);
      this.handlers.forEach((remove) => remove());
      if (this.active) {
        if (this.oldMuted) Object.defineProperty(this.video, "muted", this.oldMuted);
        else delete this.video.muted;
        muteProperty.set.call(this.video, this.logicalMuted);
        if (this.oldTracks) Object.defineProperty(this.video, "audioTracks", this.oldTracks);
        else delete this.video.audioTracks;
      }
      this.context?.close().catch(() => {});
      if (resume) this.video.play().catch(() => {});
    }
  }

  function install() {
    const player = window.Prisma?.PlayerVideo;
    if (!window.__TAURI__?.core || !player || player.__ffmpegAudio) return false;
    const originalUrl = player.url;
    const originalDestroy = player.destroy;
    player.url = function (url, ...args) {
      current?.dispose();
      current = null;
      const result = originalUrl.call(this, url, ...args);
      const video = player.video();
      if (directMedia(url) && video instanceof HTMLMediaElement) current = new AudioBridge(video, url, player);
      return result;
    };
    player.destroy = function (...args) {
      current?.dispose();
      current = null;
      return originalDestroy.apply(this, args);
    };
    player.__ffmpegAudio = true;
    return true;
  }

  window.__prismaMediaAudio = {
    install,
    status: () => ({ active: !!current?.active && !current.disposed, codec: current?.track?.codec || null }),
  };
  if (!install()) {
    const retry = setInterval(() => {
      if (install() || window.Prisma?.PlayerVideo?.__ffmpegAudio) clearInterval(retry);
    }, 250);
    window.addEventListener("pagehide", () => clearInterval(retry), { once: true });
  }
  window.addEventListener("pagehide", () => current?.dispose());
})();
