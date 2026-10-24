import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, getInfo, getPhotos, ping, uploadFile, type Info, type Photo, type ServerEvent } from "./api";
import { useEvents } from "./useEvents";

interface Item {
  id: string;
  file: File;
  preview: string;
  status: "ready" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
}

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${++counter}`;

export default function Mobile() {
  const [items, setItems] = useState<Item[]>([]);
  const [recent, setRecent] = useState<Photo[]>([]);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [reachable, setReachable] = useState(true);
  const [checking, setChecking] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const refreshRecent = useCallback(() => {
    getPhotos(8).then((r) => setRecent(r.photos)).catch(() => {});
  }, []);

  const onEvent = useCallback(
    (ev: ServerEvent) => {
      if (ev.type === "photo_received") refreshRecent();
    },
    [refreshRecent],
  );
  const { connected, send, reconnect } = useEvents("phone", onEvent);

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    refreshRecent();
    return () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview));
  }, [refreshRecent]);

  const update = (id: string, patch: Partial<Item>) => setItems((l) => l.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const next: Item[] = Array.from(list).map((file) => ({
      id: newId(),
      file,
      preview: URL.createObjectURL(file),
      status: "ready",
      progress: 0,
    }));
    setItems((l) => [...l.filter((i) => i.status !== "done"), ...next]);
  };

  const remove = (id: string) =>
    setItems((l) => {
      const it = l.find((i) => i.id === id);
      if (it) URL.revokeObjectURL(it.preview);
      return l.filter((i) => i.id !== id);
    });

  const sendOne = async (item: Item) => {
    const maxBytes = (info?.max_upload_mb ?? 40) * 1024 * 1024;
    if (item.file.size > maxBytes) {
      const error = `Too large (limit ${info?.max_upload_mb ?? 40} MB).`;
      update(item.id, { status: "error", error });
      send({ type: "progress", id: item.id, name: item.file.name, percent: 0, state: "failed", error });
      return;
    }
    update(item.id, { status: "uploading", progress: 0, error: undefined });
    let last = -1;
    const report = (percent: number) => {
      update(item.id, { progress: percent });
      if (percent !== last && (percent - last >= 5 || percent >= 99)) {
        last = percent;
        send({ type: "progress", id: item.id, name: item.file.name, percent, state: "uploading" });
      }
    };
    try {
      await uploadFile(item.file, report).promise;
      update(item.id, { status: "done", progress: 100 });
      send({ type: "progress", id: item.id, name: item.file.name, percent: 100, state: "done" });
      setReachable(true);
    } catch (e) {
      const error = e instanceof Error ? e.message : "Upload failed.";
      update(item.id, { status: "error", error });
      send({ type: "progress", id: item.id, name: item.file.name, percent: 0, state: "failed", error });
      if (/reach the laptop/.test(error)) setReachable(false);
    }
  };

  const sendAll = async () => {
    if (busy) return;
    setBusy(true);
    const queue = itemsRef.current.filter((i) => i.status === "ready" || i.status === "error");
    for (const it of queue) await sendOne(it);
    setBusy(false);
    refreshRecent();
  };

  const retry = async (item: Item) => {
    setBusy(true);
    await sendOne(item);
    setBusy(false);
    refreshRecent();
  };

  const checkConnection = async () => {
    setChecking(true);
    let ok = false;
    try {
      ok = await ping();
    } catch {
      ok = false;
    }
    setReachable(ok);
    if (ok) {
      reconnect();
      refreshRecent();
      getInfo().then(setInfo).catch(() => {});
    }
    setChecking(false);
  };

  const pending = items.filter((i) => i.status === "ready" || i.status === "error").length;
  const online = connected && reachable;
  const doneCount = items.filter((i) => i.status === "done").length;

  return (
    <div className="m">
      <header className="m-head">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 32 32" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 22l7-8 5 5 4-4 6 7" />
              <circle cx="22" cy="9" r="2.2" />
            </svg>
          </span>
          <h1>SnapBridge</h1>
        </div>
        <span className={`pill ${online ? "ok" : "bad"}`} role="status">
          <i /> {online ? "Connected" : "Offline"}
        </span>
      </header>

      {!online && (
        <div className="banner warn" role="alert">
          <span>
            Can't reach your laptop. Make sure SnapBridge is running and this phone is on the same Wi-Fi or hotspot as the laptop.
          </span>
          <button className="btn small" onClick={checkConnection} disabled={checking}>{checking ? "Checking…" : "Reconnect"}</button>
        </div>
      )}

      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      <input ref={galleryRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />

      <div className="m-actions">
        <button className="btn big primary" onClick={() => cameraRef.current?.click()} disabled={busy}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          Take Photo
        </button>
        <button className="btn big" onClick={() => galleryRef.current?.click()} disabled={busy}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          Choose from Gallery
        </button>
      </div>

      {items.length > 0 && (
        <section className="card queue" aria-label="Selected photos">
          <h2>{items.length === 1 ? "Preview" : `${items.length} photos selected`}</h2>
          <ul>
            {items.map((it) => (
              <li key={it.id} className={`q ${it.status}`}>
                <img src={it.preview} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                <div className="q-body">
                  <div className="q-name">{it.file.name}</div>
                  <div className="muted small">{formatBytes(it.file.size)}</div>
                  {it.status === "uploading" && (
                    <div className="bar" role="progressbar" aria-valuenow={it.progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${it.progress}%` }} /></div>
                  )}
                  {it.status === "error" && <div className="err small">{it.error}</div>}
                </div>
                <div className="q-side">
                  {it.status === "uploading" && <b>{it.progress}%</b>}
                  {it.status === "done" && <span className="check" aria-label="Sent">✓</span>}
                  {it.status === "error" && <button className="btn small" onClick={() => retry(it)} disabled={busy}>Retry</button>}
                  {(it.status === "ready" || it.status === "error" || it.status === "done") && (
                    <button className="x" onClick={() => remove(it.id)} aria-label="Remove" disabled={busy && it.status !== "done"}>×</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {pending > 0 && (
            <button className="btn big primary send" onClick={sendAll} disabled={busy}>
              {busy ? "Sending…" : `Send to Laptop${pending > 1 ? ` (${pending})` : ""}`}
            </button>
          )}
          {pending === 0 && !busy && doneCount > 0 && <p className="success">✓ {doneCount === 1 ? "Photo sent" : `${doneCount} photos sent`} to your laptop.</p>}
        </section>
      )}

      <section className="recent">
        <h2>Recently transferred</h2>
        {recent.length === 0 ? (
          <p className="muted">Nothing sent yet.</p>
        ) : (
          <ul>
            {recent.map((p) => (
              <li key={p.filename}>
                <img src={p.thumb_url} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                <div>
                  <div className="q-name">{p.original_name}</div>
                  <div className="muted small">{formatBytes(p.size)} · {new Date(p.received_at).toLocaleTimeString()}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted small center foot">Max {info?.max_upload_mb ?? 40} MB per photo · original quality is preserved</p>
    </div>
  );
}
