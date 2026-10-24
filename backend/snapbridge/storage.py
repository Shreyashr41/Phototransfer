from __future__ import annotations

import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import UploadFile
from PIL import Image, ImageOps

CHUNK = 1024 * 1024

EXT_MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".avif": "image/avif",
}

_ISOBMFF_BRANDS_AVIF = {b"avif", b"avis"}
_ISOBMFF_BRANDS_HEIF = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1"}


class UploadError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def sniff(head: bytes) -> tuple[str, frozenset[str]] | None:
    """Identify an image by magic bytes -> (default extension, acceptable extensions)."""
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg", frozenset({".jpg", ".jpeg"})
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png", frozenset({".png"})
    if head.startswith((b"GIF87a", b"GIF89a")):
        return ".gif", frozenset({".gif"})
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp", frozenset({".webp"})
    if head.startswith(b"BM"):
        return ".bmp", frozenset({".bmp"})
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in _ISOBMFF_BRANDS_AVIF:
            return ".avif", frozenset({".avif"})
        if brand in _ISOBMFF_BRANDS_HEIF:
            return ".heic", frozenset({".heic", ".heif", ".avif"})
    return None


def sanitize_stem(name: str) -> tuple[str, str]:
    """Reduce a client-supplied filename to a safe (stem, extension)."""
    base = (name or "").replace("\\", "/").split("/")[-1]
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip()
    stem, ext = os.path.splitext(base)
    stem = re.sub(r"[^\w\-. ()\[\]]", "_", stem, flags=re.UNICODE).strip(" .")
    stem = stem[:100] or "photo"
    # Windows reserved device names.
    if re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])", stem, re.IGNORECASE):
        stem = f"_{stem}"
    return stem, ext.lower()


def _dimensions(path: Path) -> tuple[int | None, int | None]:
    try:
        with Image.open(path) as im:
            w, h = im.size
            if im.getexif().get(274, 1) in (5, 6, 7, 8):
                w, h = h, w
            return w, h
    except Exception:
        return None, None


class Storage:
    def __init__(self, storage_dir: Path, data_dir: Path, max_bytes: int):
        self.dir = storage_dir
        self.data_dir = data_dir
        self.tmp_dir = data_dir / "tmp"
        self.thumb_dir = data_dir / "thumbs"
        self.max_bytes = max_bytes
        for d in (self.dir, self.tmp_dir, self.thumb_dir):
            d.mkdir(parents=True, exist_ok=True)
        for leftover in self.tmp_dir.glob("*.part"):
            leftover.unlink(missing_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(data_dir / "snapbridge.db", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS photos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT UNIQUE NOT NULL,
                original_name TEXT NOT NULL,
                size INTEGER NOT NULL,
                width INTEGER,
                height INTEGER,
                mime TEXT NOT NULL,
                received_at TEXT NOT NULL
            )"""
        )
        self._db.commit()

    # ---- saving -------------------------------------------------------
    def _reserve(self, stem: str, ext: str) -> Path:
        """Atomically claim a unique filename in the storage directory."""
        for n in range(0, 10000):
            name = f"{stem}{ext}" if n == 0 else f"{stem} ({n}){ext}"
            path = self.dir / name
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                continue
            os.close(fd)
            return path
        raise UploadError(500, "Could not allocate a unique filename.")

    async def save(self, upload: UploadFile) -> dict:
        original = upload.filename or "photo"
        tmp = self.tmp_dir / f"{uuid.uuid4().hex}.part"
        size = 0
        head = b""
        try:
            with open(tmp, "wb") as out:
                while chunk := await upload.read(CHUNK):
                    if len(head) < 32:
                        head = (head + chunk)[:32]
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise UploadError(
                            413, f"File is larger than the {self.max_bytes // (1024 * 1024)} MB limit."
                        )
                    out.write(chunk)
            if size == 0:
                raise UploadError(400, "The uploaded file is empty.")
            kind = sniff(head)
            if kind is None:
                raise UploadError(415, "Unsupported file type. Send a JPEG, PNG, GIF, WebP, BMP, HEIC or AVIF image.")
            default_ext, accepted = kind
            stem, ext = sanitize_stem(original)
            if ext not in accepted:
                ext = default_ext
            with self._lock:
                final = self._reserve(stem, ext)
            try:
                os.replace(tmp, final)  # atomic; the file only appears once fully written
            except OSError:
                final.unlink(missing_ok=True)
                raise
            width, height = _dimensions(final)
            record = {
                "filename": final.name,
                "original_name": os.path.basename(original.replace("\\", "/")) or final.name,
                "size": size,
                "width": width,
                "height": height,
                "mime": EXT_MIME.get(ext, "application/octet-stream"),
                "received_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            with self._lock:
                self._db.execute(
                    "INSERT INTO photos (filename, original_name, size, width, height, mime, received_at)"
                    " VALUES (:filename, :original_name, :size, :width, :height, :mime, :received_at)",
                    record,
                )
                self._db.commit()
            return self.public(record)
        finally:
            tmp.unlink(missing_ok=True)
            await upload.close()

    # ---- reading ------------------------------------------------------
    @staticmethod
    def public(row) -> dict:
        d = dict(row)
        d.pop("id", None)
        quoted = quote(d["filename"], safe="")
        d["url"] = f"/api/photos/{quoted}"
        d["thumb_url"] = f"/api/photos/{quoted}/thumb"
        return d

    def list(self, limit: int | None = None) -> list[dict]:
        q = "SELECT * FROM photos ORDER BY id DESC"
        args: tuple = ()
        if limit:
            q += " LIMIT ?"
            args = (limit,)
        with self._lock:
            rows = self._db.execute(q, args).fetchall()
        # Hide entries whose file was deleted from the folder.
        return [self.public(r) for r in rows if (self.dir / r["filename"]).is_file()]

    def resolve(self, filename: str) -> Path | None:
        """Map a client-supplied name to a file inside the storage dir, or None."""
        if not filename or filename != os.path.basename(filename) or filename in (".", ".."):
            return None
        if "/" in filename or "\\" in filename or "\x00" in filename:
            return None
        if Path(filename).suffix.lower() not in EXT_MIME:
            return None
        path = (self.dir / filename).resolve()
        if path.parent != self.dir or not path.is_file():
            return None
        return path

    def thumbnail(self, path: Path) -> Path | None:
        thumb = self.thumb_dir / f"{path.stem}-{path.stat().st_mtime_ns}-{path.stat().st_size}.jpg"
        if thumb.is_file():
            return thumb
        try:
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im)
                im.thumbnail((600, 600))
                if im.mode not in ("RGB", "L"):
                    im = im.convert("RGB")
                tmp = thumb.with_suffix(".tmp")
                im.save(tmp, format="JPEG", quality=80)
                os.replace(tmp, thumb)
            return thumb
        except Exception:
            return None
