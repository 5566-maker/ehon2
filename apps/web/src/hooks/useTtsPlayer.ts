import { useCallback, useEffect, useMemo, useRef } from 'react';

interface TtsPlayerCallbacks {
  onEnded: () => void;
  onError: () => void;
}

interface ActiveTrack {
  key: string;
  url: string;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode | null;
  /** ctx.currentTime when the current segment started. */
  startedAt: number;
  /** Position (s) in the padded buffer where the current segment started. */
  offset: number;
  paused: boolean;
}

/**
 * Silence prepended to every clip. If the platform swallows the first
 * ~200ms of a cold start, it swallows silence instead of the first syllable.
 */
const LEAD_PAD_SECONDS = 0.25;
const MAX_CACHED_BUFFERS = 24;

export interface TtsPlayer {
  /** Stop the current track and play `url` from the start. False = superseded. */
  play: (key: string, url: string) => Promise<boolean>;
  /** Toggle pause/resume for the current track. True = now paused, false = now
   * playing, null = superseded mid-flight (leave UI state alone). */
  toggle: () => Promise<boolean | null>;
  stop: () => void;
  isActive: () => boolean;
}

/**
 * TTS playback via the Web Audio API.
 *
 * A fresh HTMLAudioElement can drop the first frames while its decode/output
 * pipeline is cold, swallowing the first syllable on first play (the second
 * play sounds fine because everything is warm/cached). Here the whole clip is
 * decoded up-front with decodeAudioData, a short silence pad is prepended,
 * and decoded buffers are cached — so the first play starts exactly like the
 * second one.
 */
export function useTtsPlayer(callbacks: TtsPlayerCallbacks): TtsPlayer {
  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef(new Map<string, AudioBuffer>());
  const trackRef = useRef<ActiveTrack | null>(null);
  const generationRef = useRef(0);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const getCtx = useCallback((): AudioContext => {
    let ctx = ctxRef.current;
    if (!ctx) {
      ctx = new AudioContext();
      ctxRef.current = ctx;
    }
    return ctx;
  }, []);

  const loadBuffer = useCallback(
    async (url: string): Promise<AudioBuffer> => {
      const cached = buffersRef.current.get(url);
      if (cached) return cached;
      const ctx = getCtx();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`audio fetch failed (${res.status})`);
      const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
      const padLen = Math.max(1, Math.floor(decoded.sampleRate * LEAD_PAD_SECONDS));
      const padded = ctx.createBuffer(
        decoded.numberOfChannels,
        decoded.length + padLen,
        decoded.sampleRate,
      );
      for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
        // Leading region stays silent; copy the clip after it.
        padded.getChannelData(ch).set(decoded.getChannelData(ch), padLen);
      }
      const cache = buffersRef.current;
      if (cache.size >= MAX_CACHED_BUFFERS) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(url, padded);
      return padded;
    },
    [getCtx],
  );

  const stop = useCallback(() => {
    generationRef.current += 1;
    const track = trackRef.current;
    trackRef.current = null;
    if (track?.source) {
      track.source.onended = null;
      try {
        track.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        track.source.disconnect();
      } catch {
        /* noop */
      }
    }
  }, []);

  const startTrack = useCallback(
    (key: string, url: string, buffer: AudioBuffer, offset: number) => {
      const ctx = getCtx();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const track: ActiveTrack = {
        key,
        url,
        buffer,
        source,
        startedAt: ctx.currentTime,
        offset: Math.min(Math.max(0, offset), buffer.duration),
        paused: false,
      };
      trackRef.current = track;
      source.onended = () => {
        // pause()/stop() null onended first, so only a natural end lands here.
        if (trackRef.current === track) {
          trackRef.current = null;
          cbRef.current.onEnded();
        }
      };
      source.start(0, track.offset);
    },
    [getCtx],
  );

  const play = useCallback(
    async (key: string, url: string): Promise<boolean> => {
      stop();
      const gen = ++generationRef.current;
      const ctx = getCtx();
      try {
        const buffer = await loadBuffer(url);
        if (gen !== generationRef.current) return false; // superseded
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => {});
          if (gen !== generationRef.current) return false;
        }
        startTrack(key, url, buffer, 0);
        return true;
      } catch {
        if (gen === generationRef.current) cbRef.current.onError();
        return false;
      }
    },
    [getCtx, loadBuffer, startTrack, stop],
  );

  const toggle = useCallback(async (): Promise<boolean | null> => {
    const track = trackRef.current;
    if (!track) return false;
    const ctx = getCtx();
    if (!track.paused) {
      const elapsed = Math.max(0, ctx.currentTime - track.startedAt);
      const pos = Math.min(track.offset + elapsed, track.buffer.duration);
      if (track.source) {
        track.source.onended = null;
        try {
          track.source.stop();
        } catch {
          /* already stopped */
        }
        try {
          track.source.disconnect();
        } catch {
          /* noop */
        }
      }
      trackRef.current = { ...track, source: null, offset: pos, paused: true };
      return true;
    }
    if (ctx.state === 'suspended') {
      const gen = generationRef.current;
      await ctx.resume().catch(() => {});
      if (gen !== generationRef.current) return null; // stopped/superseded while resuming
    }
    startTrack(track.key, track.url, track.buffer, track.offset);
    return false;
  }, [getCtx, startTrack]);

  const isActive = useCallback(() => trackRef.current !== null, []);

  useEffect(
    () => () => {
      const track = trackRef.current;
      trackRef.current = null;
      if (track?.source) {
        track.source.onended = null;
        try {
          track.source.stop();
        } catch {
          /* noop */
        }
      }
      if (ctxRef.current) {
        void ctxRef.current.close().catch(() => {});
        ctxRef.current = null;
      }
    },
    [],
  );

  return useMemo(
    () => ({ play, toggle, stop, isActive }),
    [play, toggle, stop, isActive],
  );
}
