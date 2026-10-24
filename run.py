"""Start SnapBridge: python run.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

import uvicorn  # noqa: E402

from snapbridge.config import Settings  # noqa: E402
from snapbridge.netinfo import lan_candidates  # noqa: E402


def main() -> None:
    s = Settings()
    ips = lan_candidates(s.ip_override)
    print("\n  SnapBridge is starting")
    print(f"  Dashboard (this laptop): http://localhost:{s.port}")
    if ips:
        for ip in ips:
            print(f"  Phone URL:               http://{ip}:{s.port}/m")
    else:
        print("  No LAN IPv4 address found - connect to Wi-Fi or start a mobile hotspot.")
    print(f"  Photos are saved to:     {s.storage_dir}\n")
    uvicorn.run("snapbridge.main:app", host=s.host, port=s.port, log_level="info")


if __name__ == "__main__":
    main()
