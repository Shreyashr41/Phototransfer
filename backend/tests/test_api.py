import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from snapbridge.config import Settings  # noqa: E402
from snapbridge.main import create_app  # noqa: E402


@pytest.fixture
def client(tmp_path):
    s = Settings(storage_dir=tmp_path / "Received Photos", data_dir=tmp_path / "data", max_upload_mb=1)
    s.frontend_dist = tmp_path / "nodist"
    with TestClient(create_app(s), client=("127.0.0.1", 5000)) as c:
        c.settings = s
        yield c


def jpeg_bytes(size=(40, 20)):
    buf = io.BytesIO()
    Image.new("RGB", size, "red").save(buf, "JPEG")
    return buf.getvalue()


def test_health_and_info(client):
    assert client.get("/api/health").json()["status"] == "ok"
    info = client.get("/api/info").json()
    assert info["port"] == client.settings.port and info["is_local"] is True
    assert "localhost" not in (info["phone_url"] or "")


def test_upload_preserves_bytes_and_notifies(client):
    data = jpeg_bytes()
    with client.websocket_connect("/api/events?role=dashboard") as ws:
        assert ws.receive_json()["type"] == "presence"
        r = client.post("/api/upload", files={"file": ("IMG_1.jpg", data, "image/jpeg")})
        assert r.status_code == 201
        ev = ws.receive_json()
        assert ev["type"] == "photo_received" and ev["photo"]["filename"] == "IMG_1.jpg"
    assert (client.settings.storage_dir / "IMG_1.jpg").read_bytes() == data
    p = r.json()
    assert (p["width"], p["height"]) == (40, 20)
    assert client.get(p["url"]).content == data
    assert client.get(p["thumb_url"]).status_code == 200


def test_duplicate_names_get_unique(client):
    for _ in range(3):
        assert client.post("/api/upload", files={"file": ("a.jpg", jpeg_bytes(), "image/jpeg")}).status_code == 201
    names = sorted(p["filename"] for p in client.get("/api/photos").json()["photos"])
    assert names == ["a (1).jpg", "a (2).jpg", "a.jpg"]


def test_rejects_non_images_and_oversize_and_empty(client):
    assert client.post("/api/upload", files={"file": ("x.jpg", b"MZ not an image", "image/jpeg")}).status_code == 415
    assert client.post("/api/upload", files={"file": ("x.jpg", b"", "image/jpeg")}).status_code == 400
    big = jpeg_bytes() + b"\0" * (1024 * 1024 + 10)
    assert client.post("/api/upload", files={"file": ("big.jpg", big, "image/jpeg")}).status_code == 413
    assert not list(client.settings.storage_dir.iterdir())
    assert not list((client.settings.data_dir / "tmp").iterdir())


def test_hostile_filenames_are_sanitised(client):
    r = client.post("/api/upload", files={"file": ("..\\..\\evil.exe", jpeg_bytes(), "image/jpeg")})
    assert r.status_code == 201
    name = r.json()["filename"]
    assert name.endswith(".jpg") and (client.settings.storage_dir / name).is_file()
    r = client.post("/api/upload", files={"file": ("../../../escape.jpg", jpeg_bytes(), "image/jpeg")})
    assert (client.settings.storage_dir / r.json()["filename"]).is_file()
    assert not (client.settings.storage_dir.parent / "escape.jpg").exists()


def test_path_traversal_blocked(client, tmp_path):
    (tmp_path / "secret.jpg").write_bytes(jpeg_bytes())
    for bad in ["..%2Fsecret.jpg", "..%5Csecret.jpg", "%2e%2e%2fsecret.jpg", "secret.txt"]:
        assert client.get(f"/api/photos/{bad}").status_code == 404


def test_batch(client):
    files = [("files", ("a.jpg", jpeg_bytes(), "image/jpeg")), ("files", ("b.txt", b"hello", "text/plain"))]
    r = client.post("/api/upload/batch", files=files)
    assert r.status_code == 207 and r.json()["saved"] == 1 and r.json()["failed"] == 1


def test_phone_presence_and_progress_relay(client):
    with client.websocket_connect("/api/events?role=dashboard") as dash:
        dash.receive_json()
        with client.websocket_connect("/api/events?role=phone") as phone:
            assert dash.receive_json()["phones"] == 1
            phone.receive_json()
            phone.send_json({"type": "progress", "id": "1", "name": "a.jpg", "percent": 50, "state": "uploading"})
            assert dash.receive_json()["percent"] == 50
        assert dash.receive_json()["phones"] == 0


def test_open_folder_local_only(tmp_path):
    s = Settings(storage_dir=tmp_path / "p", data_dir=tmp_path / "d")
    s.frontend_dist = tmp_path / "x"
    with TestClient(create_app(s), client=("192.168.1.50", 5000)) as c:
        assert c.post("/api/open-folder").status_code == 403
