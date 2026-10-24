from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    host: str = field(default_factory=lambda: os.environ.get("SNAPBRIDGE_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _env_int("SNAPBRIDGE_PORT", 8000))
    max_upload_mb: int = field(default_factory=lambda: _env_int("SNAPBRIDGE_MAX_MB", 40))
    # Optional manual override of the LAN IP shown in the QR code.
    ip_override: str = field(default_factory=lambda: os.environ.get("SNAPBRIDGE_IP", "").strip())
    storage_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("SNAPBRIDGE_DIR", str(Path.cwd() / "Received Photos"))
        ).resolve()
    )
    data_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("SNAPBRIDGE_DATA", str(Path.cwd() / ".snapbridge"))
        ).resolve()
    )
    frontend_dist: Path = field(default_factory=lambda: ROOT_DIR / "frontend" / "dist")

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024
