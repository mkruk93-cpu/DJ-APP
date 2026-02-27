"use client";

import { useRef, useEffect, useCallback } from "react";

interface AudioVisualizerProps {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  hostRef?: React.RefObject<HTMLElement | null>;
  playing: boolean;
  barCount?: number;
  className?: string;
}

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

const sourceMap = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();

export default function AudioVisualizer({
  audioRef,
  hostRef,
  playing,
  barCount = 32,
  className = "",
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const connectedRef = useRef(false);
  const bassEnvelopeRef = useRef(0);
  const lastBassRef = useRef(0);
  const kickHitRef = useRef(0);
  const phaseRef = useRef(0);

  const connect = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || connectedRef.current) return;

    try {
      const ctx = getAudioContext();
      if (ctx.state === "suspended") ctx.resume();

      let source = sourceMap.get(audio);
      if (!source) {
        source = ctx.createMediaElementSource(audio);
        sourceMap.set(audio, source);
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;

      source.connect(analyser);
      analyser.connect(ctx.destination);

      analyserRef.current = analyser;
      connectedRef.current = true;
    } catch {
      // CORS or browser restriction — visualizer won't work but audio still plays
    }
  }, [audioRef]);

  useEffect(() => {
    if (playing && !connectedRef.current) {
      connect();
    }
  }, [playing, connect]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser || !playing) {
      cancelAnimationFrame(rafRef.current);
      bassEnvelopeRef.current = 0;
      lastBassRef.current = 0;
      kickHitRef.current = 0;
      phaseRef.current = 0;
      if (hostRef?.current) {
        hostRef.current.style.setProperty("--player-bass", "0");
        hostRef.current.style.setProperty("--kick-hit", "0");
        hostRef.current.style.setProperty("--kick-phase", "0");
      }
      return;
    }

    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const usableBins = Math.min(barCount, analyser.frequencyBinCount);

    function draw() {
      if (!canvas || !ctx2d || !analyser) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width * dpr;
      const h = rect.height * dpr;

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      analyser.getByteFrequencyData(dataArray);
      ctx2d.clearRect(0, 0, w, h);

      // Kick-focused envelope: fast attack with slightly slower release.
      const bassRaw = (dataArray[1] + dataArray[2] + dataArray[3] + dataArray[4]) / (4 * 255);
      const env = bassEnvelopeRef.current;
      const nextEnv = bassRaw > env ? bassRaw : env * 0.84;
      bassEnvelopeRef.current = nextEnv;
      const delta = bassRaw - lastBassRef.current;
      lastBassRef.current = bassRaw;
      const isKick = delta > 0.045 && bassRaw > 0.24;
      const nextKickHit = isKick ? 1 : kickHitRef.current * 0.92;
      kickHitRef.current = nextKickHit;
      phaseRef.current += 0.9 + nextEnv * 2.4 + nextKickHit * 3.4;
      if (phaseRef.current > 10000) phaseRef.current = phaseRef.current % 10000;

      if (hostRef?.current) {
        hostRef.current.style.setProperty("--player-bass", nextEnv.toFixed(3));
        hostRef.current.style.setProperty("--kick-hit", nextKickHit.toFixed(3));
        hostRef.current.style.setProperty("--kick-phase", phaseRef.current.toFixed(2));
      }

      const gap = 1.5 * dpr;
      const totalGaps = (usableBins - 1) * gap;
      const barWidth = Math.max(1, (w - totalGaps) / usableBins);
      const radius = Math.min(barWidth / 2, 2 * dpr);

      for (let i = 0; i < usableBins; i++) {
        const value = dataArray[i] / 255;
        const barHeight = Math.max(2 * dpr, value * h * 0.95);
        const x = i * (barWidth + gap);
        const y = h - barHeight;

        const alpha = 0.35 + value * 0.5;
        const gradient = ctx2d.createLinearGradient(0, y, 0, h);
        gradient.addColorStop(0, `rgba(196, 181, 253, ${Math.min(0.95, alpha + 0.2)})`);
        gradient.addColorStop(1, `rgba(139, 92, 246, ${alpha})`);
        ctx2d.fillStyle = gradient;

        ctx2d.beginPath();
        ctx2d.moveTo(x + radius, y);
        ctx2d.lineTo(x + barWidth - radius, y);
        ctx2d.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
        ctx2d.lineTo(x + barWidth, h);
        ctx2d.lineTo(x, h);
        ctx2d.lineTo(x, y + radius);
        ctx2d.quadraticCurveTo(x, y, x + radius, y);
        ctx2d.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      bassEnvelopeRef.current = 0;
      lastBassRef.current = 0;
      kickHitRef.current = 0;
      phaseRef.current = 0;
      if (hostRef?.current) {
        hostRef.current.style.setProperty("--player-bass", "0");
        hostRef.current.style.setProperty("--kick-hit", "0");
        hostRef.current.style.setProperty("--kick-phase", "0");
      }
    };
  }, [playing, barCount, hostRef]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none w-full ${className}`}
    />
  );
}
