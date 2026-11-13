import type { StreamFrame } from "@/types";

export interface StreamCallbacks {
  onStatusChange: (status: "connecting" | "connected" | "disconnected") => void;
  onFrame: (frame: StreamFrame) => void;
}

export class HubStreamClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryDelay = 1000;
  private timer: number | null = null;
  private token: string;
  private callbacks: StreamCallbacks;

  constructor(token: string, callbacks: StreamCallbacks) {
    this.token = token;
    this.callbacks = callbacks;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  updateToken(token: string): void {
    if (this.token === token) return;
    this.token = token;
    this.restart();
  }

  restart(): void {
    this.closeSocket();
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.stopped) {
      this.retryDelay = 1000;
      this.connect();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.closeSocket();
    this.callbacks.onStatusChange("disconnected");
  }

  private closeSocket(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close(1000, "client reset");
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/stream`;
    this.callbacks.onStatusChange("connecting");

    const trimmed = this.token.trim();
    const socket = trimmed
      ? new WebSocket(wsUrl, ["bearer", trimmed])
      : new WebSocket(wsUrl);
    this.ws = socket;

    socket.onopen = () => {
      this.retryDelay = 1000;
      this.callbacks.onStatusChange("connected");
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data) as StreamFrame;
        if (parsed && typeof parsed.type === "string") {
          this.callbacks.onFrame(parsed);
        }
      } catch {
        // ignore malformed frames
      }
    };

    socket.onclose = () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      this.callbacks.onStatusChange("disconnected");
      if (!this.stopped) {
        const wait = this.retryDelay + Math.floor(Math.random() * 400);
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
        this.timer = window.setTimeout(() => this.connect(), wait);
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }
}
