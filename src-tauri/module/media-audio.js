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
  let currentVideo = null;
  let currentSubtitles = null;
  let subtitleOperations = Promise.resolve();
  let videoOperations = Promise.resolve();

  function directMedia(url) {
    try {
      const parsed = new URL(url, location.href);
      return /^https?:$/.test(parsed.protocol) && !/\.(m3u8|mpd)(?:$|[/?])/i.test(parsed.pathname);
    } catch { return false; }
  }

  class AudioBridge {
    constructor(video, url, player, sourceUrl = url) {
      this.video = video;
      this.url = url;
      this.player = player;
      this.remuxed = sourceUrl !== url;
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
        if (video.getAttribute("src") !== sourceUrl) this.dispose();
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
        if (this.disposed || !tracks.length || !this.remuxed && !tracks.some((t) => /^(ac3|eac3)$/.test(t.codec))) return;
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
        if (generation === this.generation) {
          this.reading = false;
          // Fill the bounded lookahead independently of throttled WebView
          // timers. One half-second packet per timer tick can starve playback.
          if (!this.eof && !this.disposed && this.id) this.fill();
        }
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

  // MKV is not a native WKWebView container. Copy H.264 into fragmented MP4
  // and append bounded chunks to MSE; PCM still comes from the original URL.
  class VideoBridge {
    constructor(video, url, source, objectUrl) {
      Object.assign(this, { video, url, source, objectUrl, generation: 0, id: null, disposed: false });
      this.seek = () => {
        if (!this.buffer || this.disposed) return;
        const time = video.currentTime;
        if (this.restarting && Math.abs(time - this.targetSeek) < 0.05) return;
        // Restart even for a buffered seek: WebKit can keep a pending seek
        // across fragmented GOPs instead of selecting the requested frame.
        this.restart(time);
      };
      video.addEventListener("seeking", this.seek);
      source.addEventListener("sourceopen", () => this.open(), { once: true });
    }

    async open() {
      try {
        const info = await invoke("media_video_info", { url: this.url });
        if (this.disposed) return;
        if (!MediaSource.isTypeSupported(info.mime)) throw new Error("WebView не поддерживает видеокодек этого MKV");
        this.duration = info.duration;
        this.buffer = this.source.addSourceBuffer(info.mime);
        this.source.duration = info.duration;
        this.restart(this.video.currentTime || 0);
      } catch (error) { this.fail(error); }
    }

    update(action) {
      return new Promise((resolve, reject) => {
        const buffer = this.buffer;
        const finish = (error) => {
          clearTimeout(timeout);
          buffer.removeEventListener("updateend", done);
          buffer.removeEventListener("error", failed);
          error ? reject(error) : resolve();
        };
        const done = () => finish();
        const failed = () => finish(new Error("Ошибка буфера видео"));
        const timeout = setTimeout(() => finish(new Error("Истекло время обновления видео")), 15000);
        buffer.addEventListener("updateend", done, { once: true });
        buffer.addEventListener("error", failed, { once: true });
        try { action(); } catch (error) { finish(error); }
      });
    }

    restart(start) {
      this.restarting = true; this.targetSeek = start;
      const generation = ++this.generation;
      const previous = this.id; this.id = null;
      if (previous) invoke("media_video_stop", { id: previous }).catch(() => {});
      const valid = () => !this.disposed && generation === this.generation;
      videoOperations = videoOperations.catch(() => {}).then(async () => {
        if (!valid()) return;
        if (this.buffer.updating) await this.update(() => {});
        if (!valid()) return;
        // Discard an incomplete fragment from the retired FFmpeg process
        // before feeding a new init segment after an unbuffered seek.
        if (this.source.readyState === "open") this.buffer.abort();
        if (this.buffer.buffered.length) await this.update(() => this.buffer.remove(0, this.duration));
        if (!valid()) return;
        this.source.duration = this.duration;
        const { id, offset } = await invoke("media_video_start", { url: this.url, start });
        if (!valid()) { await invoke("media_video_stop", { id }); return; }
        this.buffer.timestampOffset = offset;
        this.id = id;
        // Keep the operation chain free for seeks while this session reads.
        this.pump(id, generation).catch((error) => { if (valid()) this.fail(error); });
      }).catch((error) => { if (valid()) this.fail(error); });
    }

    async pump(id, generation) {
      const valid = () => !this.disposed && this.generation === generation;
      while (valid()) {
        const time = this.video.currentTime;
        const ranges = this.buffer.buffered;
        const end = ranges.length ? ranges.end(ranges.length - 1) : time;
        if (end > time + 12) {
          if (!this.lastHeartbeat || Date.now() - this.lastHeartbeat > 10000) {
            await invoke("media_video_keep_alive", { id });
            this.lastHeartbeat = Date.now();
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const raw = await invoke("media_video_read", { id });
        if (!valid()) return;
        const data = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer;
        if (!data.byteLength) {
          if (this.source.readyState === "open" && !this.buffer.updating) this.source.endOfStream();
          return;
        }
        await this.update(() => this.buffer.appendBuffer(data));
        if (!valid()) return;
        if (!this.video.seeking && this.video.readyState >= 3) this.restarting = false;
        // Retain a short backwards window instead of the whole movie.
        if (time > 20 && this.buffer.buffered.length && this.buffer.buffered.start(0) < time - 15) {
          await this.update(() => this.buffer.remove(0, time - 10));
        }
      }
    }

    fail(error) {
      if (this.disposed) return;
      window.Prisma?.Noty?.show("FFmpeg видео: " + (typeof error === "string" ? error : error.message));
      this.dispose();
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true; this.generation++;
      this.video.removeEventListener("seeking", this.seek);
      if (this.id) invoke("media_video_stop", { id: this.id }).catch(() => {});
      URL.revokeObjectURL(this.objectUrl);
    }
  }

  class SubtitleBridge {
    constructor(video, url, sourceUrl, player) {
      Object.assign(this, { video, url, sourceUrl, player, disposed: false, generation: 0, id: null, selected: null });
      this.onTime = () => {
        if (this.selected && this.windowStart !== undefined
          && (video.currentTime < this.windowStart || video.currentTime > this.windowStart + 90)) this.restart();
        this.draw();
      };
      this.onEmpty = () => { if (video.getAttribute("src") !== sourceUrl) this.dispose(); };
      video.addEventListener("timeupdate", this.onTime);
      video.addEventListener("seeking", this.onTime);
      video.addEventListener("emptied", this.onEmpty);
      this.probe();
    }

    async probe() {
      try {
        const tracks = await invoke("media_subtitle_tracks", { url: this.url });
        if (this.disposed || !tracks.length || this.video.customSubs?.length) return;
        this.native = this.video.addTextTrack("subtitles", "FFmpeg");
        this.native.mode = "hidden";
        this.native.oncuechange = () => this.draw();
        this.items = tracks.map((track, index) => {
          const item = { index, language: track.language, label: track.title || track.language || track.codec.toUpperCase(), selected: false };
          Object.defineProperty(item, "mode", {
            get: () => this.selected === track ? "showing" : "disabled",
            set: (mode) => {
              if (this.disposed) return;
              if (mode === "showing" && this.selected !== track) {
                this.selected = track;
                this.player.subsview?.(true);
                this.items.forEach((entry) => { entry.selected = entry === item; });
                this.restart();
              } else if (mode === "disabled" && this.selected === track) {
                this.selected = null; item.selected = false; this.cancel(); this.clear(); this.draw();
                this.player.subsview?.(false);
              }
            },
          });
          return item;
        });
        this.previous = this.video.customSubs;
        this.video.customSubs = this.items;
        const saved = this.player.saveParams?.();
        if (this.items[saved?.sub]) this.items[saved.sub].mode = "showing";
        else if (window.Prisma?.Storage?.field("subtitles_start")) this.items[0].mode = "showing";
        this.player.listener.send("subs", { subs: this.items });
      } catch { /* An absent/unsupported subtitle stream leaves playback intact. */ }
    }

    draw() {
      if (this.disposed) return;
      const time = this.video.currentTime;
      const text = this.selected ? Array.from(this.native?.cues || [])
        .filter((cue) => cue.startTime <= time && cue.endTime > time).map((cue) => cue.text).join("\n") : "";
      if (text === this.lastText) return;
      this.lastText = text;
      const event = new Event("subtitle");
      event.text = text;
      this.video.dispatchEvent(event);
    }

    clear() {
      if (this.native?.cues) for (const cue of Array.from(this.native.cues)) this.native.removeCue(cue);
    }

    cancel() {
      this.generation++;
      if (this.id) invoke("media_subtitle_stop", { id: this.id }).catch(() => {});
      this.id = null;
    }

    restart() {
      this.cancel(); this.clear(); this.draw();
      if (this.disposed || !this.selected) return;
      const start = Math.max(0, this.video.currentTime - 15);
      this.windowStart = start;
      const stream = this.selected.index, generation = this.generation;
      const valid = () => !this.disposed && generation === this.generation;
      subtitleOperations = subtitleOperations.catch(() => {}).then(async () => {
        if (!valid()) return;
        const id = await invoke("media_subtitle_start", { url: this.url, stream, start });
        if (!valid()) { await invoke("media_subtitle_stop", { id }); return; }
        this.id = id;
        this.read(id, generation, start).catch((error) => { if (valid()) this.fail(error); });
      }).catch((error) => { if (valid()) this.fail(error); });
    }

    async read(id, generation, start) {
      const decoder = new TextDecoder();
      let pending = "", total = 0;
      while (!this.disposed && this.generation === generation) {
        const raw = await invoke("media_subtitle_read", { id });
        if (this.disposed || this.generation !== generation) return;
        const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
        total += bytes.byteLength;
        if (total > 2 * 1024 * 1024) throw new Error("Слишком большой фрагмент субтитров");
        pending += decoder.decode(bytes, { stream: !!bytes.byteLength }).replace(/\r/g, "");
        if (!bytes.byteLength) pending += "\n\n";
        let end;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          this.cue(pending.slice(0, end), start);
          pending = pending.slice(end + 2);
        }
        if (!bytes.byteLength) { this.id = null; await invoke("media_subtitle_stop", { id }); return; }
      }
    }

    cue(block, offset) {
      const lines = block.split("\n");
      const index = lines.findIndex((line) => line.includes(" --> "));
      if (index < 0) return;
      const match = lines[index].match(/^((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})/);
      if (!match) return;
      const seconds = (value) => value.split(":").reduce((time, part) => time * 60 + Number(part), 0);
      const begin = Math.max(0, offset + seconds(match[1]));
      const end = offset + seconds(match[2]);
      if (end > begin) { this.native.addCue(new VTTCue(begin, end, lines.slice(index + 1).join("\n"))); this.draw(); }
    }

    fail(error) {
      window.Prisma?.Noty?.show("FFmpeg субтитры: " + (typeof error === "string" ? error : error.message));
      this.selected = null; this.items?.forEach((item) => { item.selected = false; });
      this.cancel(); this.clear(); this.draw();
    }

    dispose() {
      if (this.disposed) return;
      this.cancel(); this.clear(); this.selected = null; this.draw();
      this.disposed = true;
      this.video.removeEventListener("timeupdate", this.onTime);
      this.video.removeEventListener("seeking", this.onTime);
      this.video.removeEventListener("emptied", this.onEmpty);
      if (this.native) { this.native.mode = "disabled"; this.native.oncuechange = null; }
      if (this.video.customSubs === this.items) {
        if (this.previous) this.video.customSubs = this.previous;
        else delete this.video.customSubs;
      }
    }
  }

  function install() {
    const player = window.Prisma?.PlayerVideo;
    if (!window.__TAURI__?.core || !player || player.__ffmpegAudio) return false;
    const originalUrl = player.url;
    const originalDestroy = player.destroy;
    player.url = function (url, ...args) {
      current?.dispose();
      currentVideo?.dispose();
      currentSubtitles?.dispose();
      currentSubtitles = null;
      current = null; currentVideo = null;
      const remux = directMedia(url) && /\.mkv$/i.test(new URL(url, location.href).pathname)
        && !!window.MediaSource && !document.createElement("video").canPlayType("video/x-matroska");
      const source = remux ? new MediaSource() : null;
      const sourceUrl = source ? URL.createObjectURL(source) : url;
      const result = originalUrl.call(this, sourceUrl, ...args);
      const video = player.video();
      if (directMedia(url) && video instanceof HTMLMediaElement) {
        if (source) currentVideo = new VideoBridge(video, url, source, sourceUrl);
        current = new AudioBridge(video, url, player, sourceUrl);
        if (/\.mkv$/i.test(new URL(url, location.href).pathname)) currentSubtitles = new SubtitleBridge(video, url, sourceUrl, player);
      }
      return result;
    };
    player.destroy = function (...args) {
      current?.dispose();
      currentVideo?.dispose();
      currentSubtitles?.dispose();
      currentSubtitles = null;
      current = null; currentVideo = null;
      return originalDestroy.apply(this, args);
    };
    player.__ffmpegAudio = true;
    return true;
  }

  window.__prismaMediaAudio = {
    install,
    status: () => ({
      active: !!current?.active && !current.disposed, codec: current?.track?.codec || null,
      subtitles: currentSubtitles?.items?.length || 0,
      audio: current ? { nextTime: current.nextTime, buffers: current.buffers.length, nodes: current.nodes.size,
        intent: current.intent, stalled: current.stalled, internalPause: current.internalPause,
        context: current.context?.state, gain: current.gain?.gain.value, seeking: current.video.seeking } : null,
      video: currentVideo?.buffer ? { state: currentVideo.source.readyState,
        ranges: Array.from({ length: currentVideo.buffer.buffered.length }, (_, i) => [currentVideo.buffer.buffered.start(i), currentVideo.buffer.buffered.end(i)]) } : null,
    }),
  };
  if (!install()) {
    const retry = setInterval(() => {
      if (install() || window.Prisma?.PlayerVideo?.__ffmpegAudio) clearInterval(retry);
    }, 250);
    window.addEventListener("pagehide", () => clearInterval(retry), { once: true });
  }
  window.addEventListener("pagehide", () => { current?.dispose(); currentVideo?.dispose(); currentSubtitles?.dispose(); });
})();
