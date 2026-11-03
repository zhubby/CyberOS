#!/usr/bin/python3
"""Enable only the forwarding settings owned by CyberOS Tailscale."""
import os
import pathlib
import stat

CONFIG = pathlib.Path("/etc/sysctl.d/99-cyberos-tailscale.conf")
KEYS = {
    "net.ipv4.ip_forward": "net/ipv4/ip_forward",
    "net.ipv6.conf.all.forwarding": "net/ipv6/conf/all/forwarding",
}


def parse_config(content):
    result = set()
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if separator != "=" or key.strip() not in KEYS or value.strip() != "1":
            raise ValueError("Invalid Tailscale forwarding setting")
        result.add(KEYS[key.strip()])
    return result


def apply_forwarding(keys, root=pathlib.Path("/proc/sys")):
    if not keys.issubset(set(KEYS.values())):
        raise ValueError("Unsupported forwarding setting")
    if "net/ipv6/conf/all/forwarding" in keys:
        # Forwarding otherwise disables RA on interfaces using accept_ra=1.
        # Keep explicitly disabled RA disabled, including Docker/VM interfaces.
        for path in (root / "net/ipv6/conf").glob("*/accept_ra"):
            if path.read_text().strip() == "1":
                path.write_text("2")
    for key in sorted(keys):
        (root / key).write_text("1")


def main():
    if os.geteuid() != 0:
        raise ValueError("Tailscale forwarding helper must run as root")
    metadata = CONFIG.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022 or metadata.st_size > 32768:
        raise ValueError("Unsafe Tailscale forwarding configuration")
    content = CONFIG.read_text()
    if not content.startswith("# Managed by CyberOS Tailscale\n"):
        raise ValueError("Tailscale forwarding configuration is not CyberOS managed")
    apply_forwarding(parse_config(content))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        raise SystemExit("cyberos: Tailscale forwarding could not be applied") from None
