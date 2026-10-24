# SnapBridge

Send photos from your phone to your laptop over your local Wi-Fi, instantly. Scan a QR code, tap **Take Photo**, and the original image lands in `Received Photos/` while the laptop dashboard updates live.

- **Backend:** Python FastAPI (REST + WebSocket), SQLite history, Pillow for metadata/thumbnails
- **Frontend:** React + Vite + TypeScript, served by FastAPI on the same port (so the phone needs only one URL)
- No cloud, no accounts, no paid APIs. Everything stays on your LAN.

## Quick start (Windows)

1. Install Python 3.10+ and Node.js 18+.
2. Double-click **`start.bat`** (or run it in a terminal). First run creates a virtualenv, installs dependencies and builds the frontend.
3. Open **http://localhost:8000** on the laptop. The dashboard shows the QR code.
4. Scan the QR code with the phone (both on the same Wi-Fi). Tap **Take Photo** or **Choose from Gallery**, then **Send to Laptop**.

Manual equivalent:

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
cd frontend; npm install; npm run build; cd ..
.venv\Scripts\python run.py
```

## Network setup (important)

The server listens on `0.0.0.0`, so any device on your network can reach it at `http://<laptop-ip>:8000/m`. The dashboard detects your private IPv4 address and encodes **that** address (never `localhost`) into the QR code. If several adapters exist (Wi-Fi, VirtualBox, WSL, VPN), pick the right one in the "Network address" dropdown, or force one with `SNAPBRIDGE_IP`.

SnapBridge works only when phone and laptop are on the **same local network**: the same Wi-Fi, or your phone joined to the laptop's Windows **Mobile hotspot**. It does not work across different networks or over the internet.

### Windows Firewall

The first launch usually triggers a Windows Defender Firewall prompt for Python. Tick **Private networks** and click **Allow access**. If you missed it, either run PowerShell **as Administrator**:

```powershell
.\allow-firewall.ps1            # or: .\allow-firewall.ps1 -Port 9000
```

or manually: *Windows Security → Firewall & network protection → Advanced settings → Inbound Rules → New Rule → Port → TCP 8000 → Allow → Private*.

Also check:
- **Network profile = Private** (Settings → Network & internet → Wi-Fi → your network → *Private network*). On "Public" profiles Windows blocks inbound connections.
- **Router isolation:** disable "AP/client isolation" if the phone can't reach the laptop; guest Wi-Fi networks often block this.
- **Hotspot:** with Windows Mobile hotspot the laptop IP is usually `192.168.137.1`; choose it in the dropdown after your phone joins.
- **VPNs** on laptop or phone can break local access. Disable them while transferring.

### Test connectivity
From the phone browser open `http://<laptop-ip>:8000/api/health`. You should see `{"status":"ok",...}`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `SNAPBRIDGE_PORT` | `8000` | Server port |
| `SNAPBRIDGE_HOST` | `0.0.0.0` | Bind address (keep `0.0.0.0` for phone access) |
| `SNAPBRIDGE_MAX_MB` | `40` | Max size per photo |
| `SNAPBRIDGE_DIR` | `./Received Photos` | Where photos are saved |
| `SNAPBRIDGE_DATA` | `./.snapbridge` | SQLite DB, thumbnails, temp files |
| `SNAPBRIDGE_IP` | auto | Force the LAN IP used in the QR code |

Example: `set SNAPBRIDGE_PORT=9000 && start.bat`

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Status and connected phone count |
| `GET /api/info` | Phone URL, LAN IP candidates, limits, storage path |
| `GET /api/qr.svg?url=` | QR code (only for this server's own LAN URLs) |
| `POST /api/upload` | Upload one photo (`multipart`, field `file`) |
| `POST /api/upload/batch` | Upload many (`multipart`, repeated field `files`); per-file results |
| `GET /api/photos` | List received photos (`?limit=`) |
| `GET /api/photos/{filename}` | Serve a photo (`?download=true` to download) |
| `GET /api/photos/{filename}/thumb` | JPEG thumbnail |
| `POST /api/open-folder` | Open the folder in Explorer (laptop only) |
| `WS /api/events?role=dashboard\|phone` | Live events: `presence`, `progress`, `photo_received`, `upload_failed` |

Interactive docs: http://localhost:8000/docs

## Safety and storage behaviour

- Files are streamed to a temp file, validated, then atomically moved into `Received Photos/`. Interrupted or rejected uploads never leave partial files.
- Original bytes are saved untouched (no recompression). Original filenames and extensions are kept; clashes become `name (1).jpg`, `name (2).jpg`, ….
- Type is verified from file contents (JPEG, PNG, GIF, WebP, BMP, HEIC/HEIF, AVIF), not just the extension; the extension is corrected if it lies. Oversize files get HTTP 413, wrong types 415.
- Filenames are sanitised; photo serving is restricted to the storage folder (no traversal). Uploads are never executed.
- "Open folder" only works for requests from the laptop itself.
- There is no authentication: anyone on your network who knows the address can upload. Use only on networks you trust.

## Notes on the camera

The **Take Photo** button is `<input type="file" accept="image/*" capture="environment">`. It opens the camera app on Android Chrome and works over plain HTTP. Browsers that ignore `capture` fall back to the normal file picker. **Choose from Gallery** is a separate multi-select input. HEIC photos transfer fine but may not preview in the browser.

## Development

```powershell
.venv\Scripts\python run.py            # backend on :8000
cd frontend; npm run dev               # Vite on :5173, proxies /api (incl. WebSocket) to :8000
.venv\Scripts\python -m pytest backend/tests
```

## Layout

```
backend/snapbridge/   FastAPI app (main, storage, netinfo, config)
backend/tests/        API tests
frontend/src/         React app (Dashboard, Mobile, api, useEvents)
run.py                Entry point
start.bat             One-click launcher
allow-firewall.ps1    Firewall helper
```
