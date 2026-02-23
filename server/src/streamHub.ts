/**
 * StreamHub — lightweight MP3 stream distributor that replaces Icecast.
 *
 * Receives MP3 chunks from the ffmpeg encoder's stdout, stores them in a
 * ring buffer so new listeners hear audio immediately, and broadcasts
 * every chunk to all connected HTTP clients via res.write().
 */

type Subscriber = (chunk: Buffer) => void;

export class StreamHub {
  private subscribers = new Set<Subscriber>();
  private ringBuffer: Buffer[] = [];
  private ringSize = 0;
  private maxRingSize: number;

  constructor(maxRingBytes = 256 * 1024) {
    this.maxRingSize = maxRingBytes;
  }

  broadcast(chunk: Buffer): void {
    this.ringBuffer.push(chunk);
    this.ringSize += chunk.length;

    while (this.ringSize > this.maxRingSize && this.ringBuffer.length > 1) {
      const removed = this.ringBuffer.shift()!;
      this.ringSize -= removed.length;
    }

    for (const sub of this.subscribers) {
      try {
        sub(chunk);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  getBacklog(): Buffer | null {
    if (this.ringBuffer.length === 0) return null;
    return Buffer.concat(this.ringBuffer);
  }

  get listenerCount(): number {
    return this.subscribers.size;
  }
}
