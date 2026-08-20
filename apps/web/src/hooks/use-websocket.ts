"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  RunCreateRequest,
  StreamEvent,
  WsCommandAck,
  WsErrorMessage,
  WsRpcRequest,
} from "@loomic/shared";
import { getServerBaseUrl } from "../lib/env";

type EventCallback = (event: StreamEvent) => void;
type RPCHandler = (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type WebSocketHandle = {
  connected: boolean;
  startRun: (payload: RunCreateRequest, callbacks?: RunCallbacks) => boolean;
  cancelRun: (runId: string) => void;
  onEvent: (cb: EventCallback) => () => void;
  registerRPC: (method: string, handler: RPCHandler) => () => void;
  resumeCanvas: (canvasId: string, onAck?: (ack: WsCommandAck) => void) => void;
};

export type RunCallbacks = {
  onAck: (ack: WsCommandAck) => void;
  onError: (error: WsErrorMessage) => void;
};

type WebSocketOptions = {
  onAuthExpired?: () => void;
};

export function useWebSocket(
  getToken: () => string | null,
  options: WebSocketOptions = {},
): WebSocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const connectionIdRef = useRef(
    (() => {
      if (typeof sessionStorage !== "undefined") {
        const stored = sessionStorage.getItem("ws_connection_id");
        if (stored) return stored;
        const id =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem("ws_connection_id", id);
        return id;
      }
      return typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    })(),
  );
  const [connected, setConnected] = useState(false);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = useRef(false);
  const onAuthExpiredRef = useRef(options.onAuthExpired);
  onAuthExpiredRef.current = options.onAuthExpired;

  const eventListeners = useRef<Set<EventCallback>>(new Set());
  const lastSeqByCanvasRef = useRef(new Map<string, number>());
  const resumedCanvasIdRef = useRef<string | null>(null);
  const ackListeners = useRef<Map<string, (ack: WsCommandAck) => void>>(
    new Map(),
  );
  const runListeners = useRef<Map<string, RunCallbacks>>(new Map());
  const rpcHandlers = useRef<Map<string, RPCHandler>>(new Map());

  const connect = useCallback(() => {
    const token = getToken();
    if (disposed.current) return;
    // Skip if already connected -- prevents React Strict Mode double-mount
    // from replacing an active connection mid-stream
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return;
    }
    // Close any existing connection before creating a new one
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent reconnect from old socket
      wsRef.current.close();
      wsRef.current = null;
    }
    if (!token) {
      // Token not yet available (auth loading) -- retry shortly
      reconnectTimer.current = setTimeout(connect, 500);
      return;
    }

    const serverBase = getServerBaseUrl();
    const wsUrl =
      serverBase.replace(/^http/, "ws") +
      `/api/ws?token=${encodeURIComponent(token)}&connectionId=${encodeURIComponent(connectionIdRef.current)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[ws] connected, connectionId:", connectionIdRef.current);
      setConnected(true);
      reconnectAttempt.current = 0;
    };

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch (err) {
        console.warn("[ws] failed to parse incoming message:", err);
        return;
      }

      if (msg.type === "event") {
        const streamEvent = msg.event as StreamEvent;
        // Defensive: skip malformed events without proper structure
        if (!streamEvent || typeof streamEvent !== "object") {
          console.warn("[ws] received malformed stream event:", msg);
          return;
        }
        const seq = msg.seq;
        const canvasId =
          streamEvent.type === "canvas.sync"
            ? streamEvent.canvasId
            : resumedCanvasIdRef.current;
        if (
          typeof seq === "number" &&
          Number.isSafeInteger(seq) &&
          seq > 0 &&
          canvasId
        ) {
          const lastSeq = lastSeqByCanvasRef.current.get(canvasId) ?? 0;
          if (seq <= lastSeq) {
            console.info("[ws] ignored duplicate canvas event", {
              canvasId,
              lastSeq,
              seq,
            });
            return;
          }
          lastSeqByCanvasRef.current.set(canvasId, seq);
        }
        for (const cb of eventListeners.current) {
          try {
            cb(streamEvent);
          } catch (listenerErr) {
            // Prevent one listener's error from breaking others
            console.error("[ws] event listener threw:", listenerErr);
          }
        }
      } else if (msg.type === "command.ack") {
        if (msg.action === "agent.run") {
          const payload = msg.payload as Record<string, unknown> | undefined;
          const clientRequestId = payload?.clientRequestId;
          if (typeof clientRequestId === "string") {
            const callbacks = runListeners.current.get(clientRequestId);
            if (callbacks) {
              runListeners.current.delete(clientRequestId);
              callbacks.onAck(msg as unknown as WsCommandAck);
            }
          }
          return;
        }
        const cb = ackListeners.current.get(msg.action as string);
        if (cb) {
          ackListeners.current.delete(msg.action as string);
          if (msg.action === "canvas.resume") {
            const payload = msg.payload as Record<string, unknown> | undefined;
            const canvasId = payload?.canvasId;
            const latestSeq = payload?.latestSeq;
            if (
              typeof canvasId === "string" &&
              typeof latestSeq === "number" &&
              Number.isSafeInteger(latestSeq) &&
              latestSeq >= 0
            ) {
              const currentSeq = lastSeqByCanvasRef.current.get(canvasId) ?? 0;
              if (latestSeq < currentSeq) {
                console.warn("[ws] resetting stale canvas sequence cursor", {
                  canvasId,
                  currentSeq,
                  latestSeq,
                });
                lastSeqByCanvasRef.current.set(canvasId, latestSeq);
              }
            }
          }
          try {
            cb(msg as unknown as WsCommandAck);
          } catch (ackErr) {
            console.error("[ws] ack listener threw:", ackErr);
          }
        }
      } else if (msg.type === "error" && msg.action === "agent.run") {
        const errorCode = (msg.error as { code?: string } | undefined)?.code;
        // Finalization is persisted asynchronously. Keep the accepted run's
        // listener and promise alive so resume can recover it after reconnect.
        if (errorCode === "run_finalization_unconfirmed") {
          console.warn(
            "[ws] Agent finalization is unconfirmed; preserving stream recovery state",
            { runId: msg.runId, code: errorCode },
          );
          return;
        }
        const clientRequestId = msg.clientRequestId;
        if (typeof clientRequestId === "string") {
          const callbacks = runListeners.current.get(clientRequestId);
          if (callbacks) {
            runListeners.current.delete(clientRequestId);
            callbacks.onError(msg as unknown as WsErrorMessage);
          }
        }
        const runId = msg.runId;
        if (typeof runId === "string") {
          console.error("[ws] active Agent run failed:", {
            runId,
            code: errorCode,
          });
          const timestamp = new Date().toISOString();
          const streamEvent: StreamEvent =
            errorCode === "assistant_message_persistence_failed"
              ? { type: "assistant.persistence_failed", runId, timestamp }
              : {
                  type: "run.failed",
                  runId,
                  timestamp,
                  error: {
                    code: "run_failed",
                    message:
                      (msg.error as { message?: string } | undefined)
                        ?.message ?? "Agent stream could not be completed.",
                  },
                };
          for (const cb of eventListeners.current) cb(streamEvent);
        }
      } else if (msg.type === "rpc.request") {
        void handleRpcRequest(ws, msg as unknown as WsRpcRequest);
      }
      // Unknown message types are silently ignored -- server may add new types
    };

    ws.onclose = (event) => {
      // Only handle close for the CURRENT connection.
      // React Strict Mode creates two connections; when the server replaces
      // the old one, its close event fires after remount resets disposed=false.
      // Without this guard, we'd enter a reconnect loop.
      if (wsRef.current !== ws) return;

      setConnected(false);
      wsRef.current = null;

      if (event.code === 4001) {
        console.warn("[ws] authentication rejected; ending connection");
        onAuthExpiredRef.current?.();
        return;
      }

      if (!disposed.current) {
        const delay = Math.min(
          30_000,
          1000 * Math.pow(2, reconnectAttempt.current),
        );
        const attempt = reconnectAttempt.current + 1;
        console.log(
          `[ws] scheduling reconnect attempt ${attempt} in ${delay}ms (code: ${event.code})`,
        );
        reconnectAttempt.current = attempt;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [getToken]);

  async function handleRpcRequest(ws: WebSocket, req: WsRpcRequest) {
    const handler = rpcHandlers.current.get(req.method);
    if (!handler) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "rpc.response",
            id: req.id,
            error: `No handler for method: ${req.method}`,
          }),
        );
      }
      return;
    }

    try {
      const result = await handler(req.params);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "rpc.response", id: req.id, result }));
      }
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "rpc.response",
            id: req.id,
            error:
              error instanceof Error ? error.message : "RPC handler failed",
          }),
        );
      }
    }
  }

  useEffect(() => {
    disposed.current = false;
    connect();
    return () => {
      disposed.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const sendCommand = useCallback(
    (action: string, payload: Record<string, unknown>): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn(
          "[ws] command dropped -- not connected, readyState:",
          ws?.readyState,
        );
        return false;
      }
      try {
        ws.send(JSON.stringify({ type: "command", action, payload }));
        return true;
      } catch (err) {
        // Guard against serialization errors (e.g. circular refs in payload)
        console.error("[ws] failed to send command:", action, err);
        return false;
      }
    },
    [],
  );

  const startRun = useCallback(
    (payload: RunCreateRequest, callbacks?: RunCallbacks): boolean => {
      resumedCanvasIdRef.current = payload.canvasId;
      if (callbacks)
        runListeners.current.set(payload.clientRequestId, callbacks);
      const sent = sendCommand(
        "agent.run",
        payload as unknown as Record<string, unknown>,
      );
      if (!sent) {
        runListeners.current.delete(payload.clientRequestId);
      }
      return sent;
    },
    [sendCommand],
  );

  const cancelRun = useCallback(
    (runId: string) => {
      sendCommand("agent.cancel", { runId });
    },
    [sendCommand],
  );

  const resumeCanvas = useCallback(
    (canvasId: string, onAck?: (ack: WsCommandAck) => void) => {
      if (onAck) {
        ackListeners.current.set("canvas.resume", onAck);
      }
      resumedCanvasIdRef.current = canvasId;
      const sent = sendCommand("canvas.resume", {
        canvasId,
        lastSeq: lastSeqByCanvasRef.current.get(canvasId) ?? 0,
      });
      if (!sent) {
        ackListeners.current.delete("canvas.resume");
      }
    },
    [sendCommand],
  );

  const onEvent = useCallback((cb: EventCallback) => {
    eventListeners.current.add(cb);
    return () => {
      eventListeners.current.delete(cb);
    };
  }, []);

  const registerRPC = useCallback((method: string, handler: RPCHandler) => {
    rpcHandlers.current.set(method, handler);
    return () => {
      rpcHandlers.current.delete(method);
    };
  }, []);

  return { connected, startRun, cancelRun, onEvent, registerRPC, resumeCanvas };
}
