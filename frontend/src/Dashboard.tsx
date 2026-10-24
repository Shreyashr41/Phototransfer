import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatTime, getInfo, getPhotos, openFolder, type Info, type Photo, type ServerEvent } from "./api";
import { useEvents } from "./useEvents";

interface Activity {
  key: string;
  kind: "progress" | "success" | "error" | "info";
  text: string;
  detail?: string;
  percent?: number;
  at: number;
}

function Thumb({ photo, className }: { photo: Photo; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className={`thumb-fallback ${className ?? ""}`}>{photo.filename.split(".").pop()?.toUpperCase()}</div>;
  return <img className={className} src={photo.thumb_url} alt={photo.original_name} loading="lazy" onError={() => setFailed(true)} />;
}

export default function Dashboard() {
  const [info, setInfo] = useState<Info | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [preview, setPreview] = useState<Photo | null>(null);
  const [copied, setCopied] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const seen = useRef(new Set<string>());

  const addActivity = useCallback((a: Omit<Activity, "at">) => {
    setActivity((list) => {
      const rest = list.filter((x) => x.key !== a.key);
      return [{ ...a, at: Date.now() }, ...rest].slice(0, 40);
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const [i, p] = await Promise.all([getInfo(), getPhotos()]);
      setInfo(i);
      setPhotos(p.photos);
      seen.current = new Set(p.photos.map((x) => x.filename));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the SnapBridge server.");
    }
  }, []);

  const onEvent = useCallback(
    (ev: ServerEvent) => {
      if (ev.type === "photo_received") {
        const p = ev.photo;
        if (!seen.current.has(p.filename)) {
          seen.current.add(p.filename);
          setPhotos((list) => [p, ...list]);
        }
        setFresh(p.filename);
        window.setTimeout(() => setFresh((f) => (f === p.filename ? null : f)), 3000);
        addActivity({ key: `saved-${p.filename}`, kind: "success", text: `Received ${p.original_name}`, detail: `${formatBytes(p.size)} · saved as ${p.filename}` });
      } else if (ev.type === "progress") {
        if (ev.state === "uploading") addActivity({ key: `up-${ev.id}`, kind: "progress", text: `Receiving ${ev.name}`, percent: ev.percent });
        else if (ev.state === "failed") addActivity({ key: `up-${ev.id}`, kind: "error", text: `Transfer failed: ${ev.name}`, detail: ev.error ?? undefined });
        else setActivity((l) => l.filter((x) => x.key !== `up-${ev.id}`));
      } else if (ev.type === "upload_failed") {
        addActivity({ key: `fail-${Date.now()}`, kind: "error", text: `Rejected ${ev.name ?? "file"}`, detail: ev.error });
      }
    },
    [addActivity],
  );

  const { connected, presence, reconnect } = useEvents("dashboard", onEvent);

  useEffect(() => {
    load();
  }, [load]);

  // Re-sync after the socket comes back so nothing received while offline is missed.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connected && !wasConnected.current && info) load();
    wasConnected.current = connected;
  }, [connected, info, load]);

  const phoneConnected = presence.phones > 0;
  const prevPhone = useRef(false);
  useEffect(() => {
    if (phoneConnected !== prevPhone.current && info) {
      addActivity({ key: `phone-${Date.now()}`, kind: "info", text: phoneConnected ? "Phone connected" : "Phone disconnected" });
    }
    prevPhone.current = phoneConnected;
  }, [phoneConnected, info, addActivity]);

  const candidate = useMemo(() => {
    if (!info) return null;
    return info.candidates.find((c) => c.ip === selectedIp) ?? info.candidates[0] ?? null;
  }, [info, selectedIp]);

  const totalBytes = photos.reduce((n, p) => n + p.size, 0);

  const copy = async () => {
    if (!candidate) return;
    try {
      await navigator.clipboard.writeText(candidate.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copy failed. Select the URL and copy it manually.");
    }
  };

  const doOpenFolder = async () => {
    try {
      await openFolder();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the folder.");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPreview(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="dash">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 22l7-8 5 5 4-4 6 7" />
              <circle cx="22" cy="9" r="2.2" />
            </svg>
          </span>
          <div>
            <h1>SnapBridge</h1>
            <p>Phone → laptop photo transfer</p>
          </div>
        </div>
        <div className="pills" role="status" aria-live="polite">
          <span className={`pill ${connected ? "ok" : "bad"}`}>
            <i /> Server {connected ? "online" : "offline"}
          </span>
          <span className={`pill ${phoneConnected ? "ok" : "idle"}`}>
            <i /> {phoneConnected ? `Phone connected${presence.phones > 1 ? ` (${presence.phones})` : ""}` : "Waiting for phone"}
          </span>
        </div>
      </header>

      {error && (
        <div className="banner error" role="alert">
          <span>{error}</span>
          <div>
            <button className="btn small" onClick={() => { reconnect(); load(); }}>Retry</button>
            <button className="btn small ghost" onClick={() => setError(null)}>Dismiss</button>
          </div>
        </div>
      )}
      {!connected && !error && (
        <div className="banner warn" role="alert">
          <span>Live updates are disconnected. Is the SnapBridge server still running? Reconnecting automatically…</span>
          <button className="btn small" onClick={reconnect}>Reconnect now</button>
        </div>
      )}

      <main className="grid">
        <section className="card qr-card">
          <h2>Connect your phone</h2>
          {candidate ? (
            <>
              <div className="qr">
                <img src={`/api/qr.svg?url=${encodeURIComponent(candidate.url)}`} alt={`QR code for ${candidate.url}`} width={232} height={232} />
              </div>
              <p className="muted center">Scan with your phone camera. Both devices must be on the same Wi-Fi or hotspot.</p>
              <div className="urlbox">
                <code>{candidate.url}</code>
                <button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
              </div>
              {info && info.candidates.length > 1 && (
                <label className="select">
                  <span>Network address</span>
                  <select value={candidate.ip} onChange={(e) => setSelectedIp(e.target.value)}>
                    {info.candidates.map((c) => (
                      <option key={c.ip} value={c.ip}>{c.ip}</option>
                    ))}
                  </select>
                  <small>Multiple networks found. Pick the Wi-Fi or hotspot address your phone is on.</small>
                </label>
              )}
              <dl className="meta">
                <div><dt>Laptop IP</dt><dd>{candidate.ip}</dd></div>
                <div><dt>Port</dt><dd>{info?.port}</dd></div>
              </dl>
            </>
          ) : (
            <div className="empty">
              <p><strong>{info ? "No local network found." : "Detecting network…"}</strong></p>
              {info && <p className="muted">Connect this laptop to Wi-Fi, or start a Mobile Hotspot (Settings → Network → Mobile hotspot) and join it from your phone. Then retry.</p>}
              <button className="btn" onClick={load}>Retry detection</button>
            </div>
          )}
          <details className="help">
            <summary>Phone can't connect?</summary>
            <ul>
              <li>Phone and laptop must share the same Wi-Fi (or the phone joins the laptop's hotspot).</li>
              <li>Allow SnapBridge through Windows Firewall for <b>Private</b> networks (see README).</li>
              <li>Set the Wi-Fi network profile to <b>Private</b> in Windows settings.</li>
              <li>Turn off "AP/client isolation" on the router if enabled; guest networks often block devices.</li>
            </ul>
          </details>
        </section>

        <section className="col">
          <div className="stats">
            <div className="card stat"><span>Transfers</span><strong>{photos.length}</strong></div>
            <div className="card stat"><span>Data received</span><strong>{formatBytes(totalBytes)}</strong></div>
            <div className="card stat folder">
              <span title={info?.storage_dir}>Saved to</span>
              <button className="btn" onClick={doOpenFolder}>Open photos folder</button>
            </div>
          </div>

          <div className="card feed">
            <h2>Live activity</h2>
            {activity.length === 0 ? (
              <p className="muted">Nothing yet. Scan the QR code and send a photo.</p>
            ) : (
              <ul>
                {activity.map((a) => (
                  <li key={a.key} className={`act ${a.kind}`}>
                    <span className="dot" />
                    <div>
                      <div className="act-text">{a.text}</div>
                      {a.detail && <div className="muted small">{a.detail}</div>}
                      {a.kind === "progress" && (
                        <div className="bar" role="progressbar" aria-valuenow={a.percent} aria-valuemin={0} aria-valuemax={100}>
                          <span style={{ width: `${a.percent ?? 0}%` }} />
                        </div>
                      )}
                    </div>
                    {a.kind === "progress" ? <b>{a.percent}%</b> : <time className="muted small">{new Date(a.at).toLocaleTimeString()}</time>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>

      <section className="gallery-wrap">
        <div className="section-head">
          <h2>Received photos</h2>
          <button className="btn ghost small" onClick={load}>Refresh</button>
        </div>
        {photos.length === 0 ? (
          <div className="card empty"><p className="muted">Photos you send from your phone will appear here instantly.</p></div>
        ) : (
          <div className="gallery">
            {photos.map((p) => (
              <article key={p.filename} className={`card photo ${fresh === p.filename ? "fresh" : ""}`}>
                <button className="thumb-btn" onClick={() => setPreview(p)} aria-label={`Preview ${p.original_name}`}>
                  <Thumb photo={p} />
                </button>
                <div className="photo-info">
                  <h3 title={p.original_name}>{p.original_name}</h3>
                  <p className="muted small">
                    {formatBytes(p.size)}
                    {p.width && p.height ? ` · ${p.width}×${p.height}` : ""}
                  </p>
                  <p className="muted small">{formatTime(p.received_at)}</p>
                  {p.filename !== p.original_name && <p className="muted small" title="Renamed to avoid overwriting">Saved as {p.filename}</p>}
                  <div className="actions">
                    <button className="btn small" onClick={() => setPreview(p)}>Preview</button>
                    <a className="btn small ghost" href={p.url} target="_blank" rel="noreferrer">Open</a>
                    <a className="btn small ghost" href={`${p.url}?download=true`}>Save</a>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {preview && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={preview.original_name} onClick={() => setPreview(null)}>
          <div className="lb-inner" onClick={(e) => e.stopPropagation()}>
            <img src={preview.url} alt={preview.original_name} onError={(e) => ((e.target as HTMLImageElement).src = preview.thumb_url)} />
            <div className="lb-bar">
              <span>{preview.original_name} · {formatBytes(preview.size)}</span>
              <div>
                <a className="btn small" href={preview.url} target="_blank" rel="noreferrer">Open full size</a>
                <button className="btn small ghost" onClick={() => setPreview(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
