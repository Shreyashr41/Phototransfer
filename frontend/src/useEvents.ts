import { useCallback, useEffect, useRef, useState } from "react";
import type { Presence, ServerEvent } from "./api";

export function useEvents(role: "phone" | "dashboard", onEvent: (e: ServerEvent) => void) {
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<Presence>({ phones: 0, dashboards: 0 });
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const wsRef = useRef<WebSocket | null>(null);
  const retry = useRef(0);
  const timer = useRef<number>();
  const closed = useRef(false);

  const connect = useCallback(() => {
    window.clearTimeout(timer.current);
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/events?role=${role}`);
    wsRef.current = ws;
    ws.onopen = () => {
      retry.current = 0;
      setConnected(true);
    };
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as ServerEvent;
        if (ev.type === "presence") setPresence({ phones: ev.phones, dashboards: ev.dashboards });
        handler.current(ev);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      setConnected(false);
      setPresence({ phones: 0, dashboards: 0 });
      if (wsRef.current === ws) wsRef.current = null;
      if (!closed.current) {
        const delay = Math.min(10000, 1000 * 2 ** retry.current++);
        timer.current = window.setTimeout(connect, delay);
      }
    };
    ws.onerror = () => ws.close();
  }, [role]);

  useEffect(() => {
    closed.current = false;
    connect();
    // Keep the socket alive and detect silent drops (phone sleeping, Wi-Fi roaming).
    const keepAlive = window.setInterval(() => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 15000);
    const onVisible = () => {
      if (document.visibilityState === "visible") connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", connect);
    return () => {
      closed.current = true;
      window.clearInterval(keepAlive);
      window.clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", connect);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(msg));
  }, []);

  const reconnect = useCallback(() => {
    retry.current = 0;
    wsRef.current?.close();
    wsRef.current = null;
    connect();
  }, [connect]);

  return { connected, presence, send, reconnect };
}
