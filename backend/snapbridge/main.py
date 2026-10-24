from __future__ import annotations

import asyncio
import io
import os
import socket
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import qrcode
import qrcode.image.svg
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import Settings
from .netinfo import lan_candidates
from .storage import EXT_MIME, Storage, UploadError

LOOPBACK = {"127.0.0.1", "::1", "localhost"}


class Hub:
    """Tracks WebSocket clients and broadcasts events to all of them."""

    def __init__(self) -> None:
        self.clients: dict[WebSocket, str] = {}

    def presence(self) -> dict:
        roles = list(self.clients.values())
        return {"type": "presence", "phones": roles.count("phone"), "dashboards": roles.count("dashboard")}

    async def broadcast(self, message: dict, skip: WebSocket | None = None) -> None:
        for ws in list(self.clients):
            if ws is skip:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                self.clients.pop(ws, None)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    hub = Hub()
    storage = Storage(settings.storage_dir, settings.data_dir, settings.max_upload_bytes)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield

    app = FastAPI(title="SnapBridge", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.storage = storage

    def is_local(request: Request) -> bool:
        host = request.client.host if request.client else ""
        return host in LOOPBACK or host in {c["ip"] for c in phone_urls()}

    def phone_urls() -> list[dict]:
        return [
            {"ip": ip, "url": f"http://{ip}:{settings.port}/m"} for ip in lan_candidates(settings.ip_override)
        ]

    # ---- info ---------------------------------------------------------
    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "version": __version__,
            "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "phones_connected": hub.presence()["phones"],
        }

    @app.get("/api/info")
    async def info(request: Request):
        candidates = phone_urls()
        return {
            "app": "SnapBridge",
            "version": __version__,
            "hostname": socket.gethostname(),
            "port": settings.port,
            "ip": candidates[0]["ip"] if candidates else None,
            "phone_url": candidates[0]["url"] if candidates else None,
            "candidates": candidates,
            "max_upload_mb": settings.max_upload_mb,
            "storage_dir": str(settings.storage_dir),
            "allowed_extensions": sorted(EXT_MIME),
            "is_local": is_local(request),
            **{k: v for k, v in hub.presence().items() if k != "type"},
        }

    @app.get("/api/qr.svg")
    async def qr(url: str):
        # Only encode URLs that point at this server's own LAN addresses.
        if not any(url == c["url"] for c in phone_urls()):
            raise HTTPException(400, "URL is not a SnapBridge connection address.")
        img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
        buf = io.BytesIO()
        img.save(buf)
        return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})

    # ---- uploads ------------------------------------------------------
    def check_length(request: Request) -> None:
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > settings.max_upload_bytes + 1024 * 1024:
            raise HTTPException(413, f"Upload is larger than the {settings.max_upload_mb} MB limit.")

    async def save_and_announce(file: UploadFile) -> dict:
        photo = await storage.save(file)
        await hub.broadcast({"type": "photo_received", "photo": photo})
        return photo

    @app.post("/api/upload", status_code=201)
    async def upload(request: Request, file: UploadFile = File(...)):
        check_length(request)
        try:
            return await save_and_announce(file)
        except UploadError as e:
            await hub.broadcast({"type": "upload_failed", "name": file.filename, "error": e.message})
            raise HTTPException(e.status, e.message)

    @app.post("/api/upload/batch")
    async def upload_batch(request: Request, files: list[UploadFile] = File(...)):
        check_length(request)
        results = []
        for f in files:
            try:
                results.append({"ok": True, "name": f.filename, "photo": await save_and_announce(f)})
            except UploadError as e:
                await hub.broadcast({"type": "upload_failed", "name": f.filename, "error": e.message})
                results.append({"ok": False, "name": f.filename, "status": e.status, "error": e.message})
        ok = sum(1 for r in results if r["ok"])
        code = 201 if ok == len(results) else (207 if ok else 400)
        return JSONResponse({"saved": ok, "failed": len(results) - ok, "results": results}, status_code=code)

    # ---- photos -------------------------------------------------------
    @app.get("/api/photos")
    async def photos(limit: int | None = None):
        if limit is not None and not 1 <= limit <= 1000:
            raise HTTPException(400, "limit must be between 1 and 1000.")
        items = await run_in_threadpool(storage.list, limit)
        return {"count": len(items), "total_bytes": sum(p["size"] for p in items), "photos": items}

    @app.get("/api/photos/{filename}")
    async def photo(filename: str, download: bool = False):
        path = storage.resolve(filename)
        if path is None:
            raise HTTPException(404, "Photo not found.")
        return FileResponse(
            path,
            media_type=EXT_MIME.get(path.suffix.lower(), "application/octet-stream"),
            filename=path.name,
            content_disposition_type="attachment" if download else "inline",
            headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"},
        )

    @app.get("/api/photos/{filename}/thumb")
    async def photo_thumb(filename: str):
        path = storage.resolve(filename)
        if path is None:
            raise HTTPException(404, "Photo not found.")
        thumb = await run_in_threadpool(storage.thumbnail, path)
        if thumb is None:
            raise HTTPException(404, "No preview available for this format.")
        return FileResponse(
            thumb, media_type="image/jpeg", headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400"}
        )

    @app.post("/api/open-folder")
    async def open_folder(request: Request):
        if not is_local(request):
            raise HTTPException(403, "The folder can only be opened from the laptop itself.")
        try:
            folder = str(settings.storage_dir)
            if sys.platform.startswith("win"):
                os.startfile(folder)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", folder])
            else:
                subprocess.Popen(["xdg-open", folder])
        except Exception as e:
            raise HTTPException(500, f"Could not open the folder: {e}")
        return {"opened": str(settings.storage_dir)}

    # ---- websocket ----------------------------------------------------
    @app.websocket("/api/events")
    async def events(ws: WebSocket, role: str = "dashboard"):
        await ws.accept()
        role = "phone" if role == "phone" else "dashboard"
        hub.clients[ws] = role
        await hub.broadcast(hub.presence())
        try:
            while True:
                msg = await ws.receive_json()
                if not isinstance(msg, dict):
                    continue
                if msg.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
                elif role == "phone" and msg.get("type") == "progress":
                    await hub.broadcast(
                        {
                            "type": "progress",
                            "id": str(msg.get("id", ""))[:64],
                            "name": str(msg.get("name", ""))[:200],
                            "percent": max(0, min(100, int(msg.get("percent") or 0))),
                            "state": msg.get("state") if msg.get("state") in ("uploading", "done", "failed") else "uploading",
                            "error": str(msg.get("error", ""))[:300] or None,
                        },
                        skip=ws,
                    )
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            hub.clients.pop(ws, None)
            await hub.broadcast(hub.presence())

    # ---- frontend -----------------------------------------------------
    dist = settings.frontend_dist
    if (dist / "index.html").is_file():

        @app.get("/m", include_in_schema=False)
        async def mobile_page():
            return FileResponse(dist / "index.html")

        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    else:

        @app.get("/", include_in_schema=False)
        async def no_frontend():
            return JSONResponse(
                {"message": "Frontend not built. Run `npm install && npm run build` in /frontend, or use start.bat."},
                status_code=503,
            )

    return app


app = create_app()
