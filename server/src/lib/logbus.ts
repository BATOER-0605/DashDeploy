import { EventEmitter } from "node:events";
import { appendEvent, type LogStream } from "../db/deployments.js";

export interface LogLine {
  id: number;
  ts: string;
  stream: LogStream;
  line: string;
}

export interface DoneEvent {
  type: "done";
}

type Listener = (line: LogLine) => void;
type DoneListener = () => void;

/**
 * Per-deployment fan-out of log lines to connected SSE clients.
 * Every published line is also persisted so a reconnecting client can replay it.
 */
class LogBus {
  private readonly emitters = new Map<number, EventEmitter>();

  private emitterFor(deploymentId: number): EventEmitter {
    let e = this.emitters.get(deploymentId);
    if (!e) {
      e = new EventEmitter();
      e.setMaxListeners(50);
      this.emitters.set(deploymentId, e);
    }
    return e;
  }

  /** Persist a log line and push it to any connected listeners. */
  publish(deploymentId: number, stream: LogStream, line: string): void {
    const event = appendEvent(deploymentId, stream, line);
    this.emitterFor(deploymentId).emit("line", {
      id: event.id,
      ts: event.ts,
      stream: event.stream,
      line: event.line,
    } satisfies LogLine);
  }

  /** Signal that the deployment finished — closes SSE streams. */
  finish(deploymentId: number): void {
    const e = this.emitters.get(deploymentId);
    if (e) {
      e.emit("done");
      // Allow late-joining clients to still connect & replay; drop after a delay.
      setTimeout(() => this.emitters.delete(deploymentId), 30_000);
    }
  }

  onLine(deploymentId: number, listener: Listener): () => void {
    const e = this.emitterFor(deploymentId);
    e.on("line", listener);
    return () => e.off("line", listener);
  }

  onDone(deploymentId: number, listener: DoneListener): () => void {
    const e = this.emitterFor(deploymentId);
    e.on("done", listener);
    return () => e.off("done", listener);
  }
}

export const logbus = new LogBus();
