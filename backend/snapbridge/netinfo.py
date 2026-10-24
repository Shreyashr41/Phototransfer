from __future__ import annotations

import ipaddress
import socket


def _is_usable(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # 169.254.x.x is link-local (no DHCP) and not useful for phones.
    return addr.version == 4 and addr.is_private and not addr.is_loopback and not addr.is_link_local


def _route_ip() -> str | None:
    """IP of the interface used for the default route (no packets are sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def _score(ip: str) -> int:
    # Prefer typical home Wi-Fi / hotspot ranges over virtual adapters (Docker, WSL, VPN).
    if ip.startswith("192.168."):
        return 0
    if ip.startswith("172.") and not ip.startswith(("172.16.", "172.17.", "172.18.")):
        return 1
    if ip.startswith("10."):
        return 2
    return 3


def lan_candidates(override: str = "") -> list[str]:
    """Usable private IPv4 addresses of this machine, best guess first."""
    route = _route_ip()
    others: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if _is_usable(ip):
                others.append(ip)
    except OSError:
        pass
    ordered: list[str] = []
    if override:
        ordered.append(override)
    if route and _is_usable(route):
        ordered.append(route)
    ordered.extend(sorted(others, key=_score))
    return list(dict.fromkeys(ordered))
