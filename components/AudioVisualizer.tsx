"use client";

import { useRef, useEffect, useCallback } from "react";

interface AudioVisualizerProps {
  audioRef: React.RefObject<HTMLAudioElement | null>;
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
  playing,
  barCount = 32,
  className = "",
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const connectedRef = useRef(false);

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

      const gap = 1.5 * dpr;
      const totalGaps = (usableBins - 1) * gap;
      const barWidth = Math.max(1, (w - totalGaps) / usableBins);
      const radius = Math.min(barWidth / 2, 2 * dpr);

      for (let i = 0; i < usableBins; i++) {
        const value = dataArray[i] / 255;
        const barHeight = Math.max(2 * dpr, value * h * 0.95);
        const x = i * (barWidth + gap);
        const y = h - barHeight;

        const alpha = 0.45 + value * 0.55;
        ctx2d.fillStyle = `rgba(139, 92, 246, ${alpha})`;

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

    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, barCount]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none w-full ${className}`}
    />
  );
}
