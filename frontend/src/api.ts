export interface Photo {
  filename: string;
  original_name: string;
  size: number;
  width: number | null;
  height: number | null;
  mime: string;
  received_at: string;
  url: string;
  thumb_url: string;
}

export interface Candidate {
  ip: string;
  url: string;
}

export interface Info {
  version: string;
  hostname: string;
  port: number;
  ip: string | null;
  phone_url: string | null;
  candidates: Candidate[];
  max_upload_mb: number;
  storage_dir: string;
  is_local: boolean;
  phones: number;
}

export interface Presence {
  phones: number;
  dashboards: number;
}

export type ServerEvent =
  | ({ type: "presence" } & Presence)
  | { type: "photo_received"; photo: Photo }
  | { type: "upload_failed"; name: string | null; error: string }
  | { type: "progress"; id: string; name: string; percent: number; state: "uploading" | "done" | "failed"; error: string | null }
  | { type: "pong" };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.detail) msg = typeof body.detail === "string" ? body.detail : msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const getInfo = () => fetch("/api/info").then((r) => json<Info>(r));
export const getPhotos = (limit?: number) =>
  fetch(`/api/photos${limit ? `?limit=${limit}` : ""}`).then((r) => json<{ count: number; total_bytes: number; photos: Photo[] }>(r));
export const openFolder = () => fetch("/api/open-folder", { method: "POST" }).then((r) => json<{ opened: string }>(r));
export const ping = () => fetch("/api/health", { cache: "no-store" }).then((r) => r.ok);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function uploadFile(
  file: File,
  onProgress: (percent: number) => void,
): { promise: Promise<Photo>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Photo>((resolve, reject) => {
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve(body as Photo);
      } else {
        reject(new Error(typeof body?.detail === "string" ? body.detail : `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Can't reach the laptop. Check that you're on the same Wi-Fi."));
    xhr.ontimeout = () => reject(new Error("The upload timed out."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
