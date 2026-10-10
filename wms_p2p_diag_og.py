#!/usr/bin/env python3
"""Small coturn/STUN/TURN diagnostic

What it tests (--wms-url + --group-token):
  1. Register a simulated ThinOS device to the WMS server
  2. Check-in the device with bare-minimum data (random IP/MAC)
  3. Fetch encrypted WebRTC details via /device/getWebRTCDetails
  4. Run all diagnostic tests using the server-provided credentials

TURN allocation / relay tests use aioice instead of hand-building TURN packets.
Install it with:
    python -m pip install "aioice>=0.10.2,<1"

For WMS mode, also install:
    python -m pip install requests pycryptodome

"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import random
import re
import secrets
import socket
import ssl
import string
import struct
import sys
import time
import urllib.parse
from dataclasses import asdict, dataclass
from typing import Any, Dict, Iterable, Optional, Tuple

MAGIC_COOKIE = 0x2112A442
STUN_BINDING_REQUEST = 0x0001
STUN_BINDING_SUCCESS = 0x0101
STUN_BINDING_ERROR = 0x0111
ATTR_MAPPED_ADDRESS = 0x0001
ATTR_ERROR_CODE = 0x0009
ATTR_XOR_MAPPED_ADDRESS = 0x0020


@dataclass
class Result:
    name: str
    status: str  # PASS / FAIL / SKIP / WARN
    detail: str
    elapsed_ms: float


def timed_result(name: str, started: float, status: str, detail: str) -> Result:
    return Result(name, status, detail, round((time.monotonic() - started) * 1000, 1))


def unique_addresses(host: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for family, _, _, _, sockaddr in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM):
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        ip = sockaddr[0]
        if ip not in seen:
            seen.add(ip)
            out.append(ip)
    return out


def test_dns(host: str) -> Result:
    name = "DNS"
    started = time.monotonic()
    try:
        addresses = unique_addresses(host)
        if not addresses:
            return timed_result(name, started, "FAIL", "no A/AAAA addresses returned")
        return timed_result(name, started, "PASS", ", ".join(addresses))
    except Exception as exc:
        return timed_result(name, started, "FAIL", f"{type(exc).__name__}: {exc}")


def test_tcp(host: str, port: int, timeout: float, label: str) -> Result:
    name = f"TCP {label} {host}:{port}"
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            peer = sock.getpeername()
        return timed_result(name, started, "PASS", f"connected to {peer[0]}:{peer[1]}")
    except Exception as exc:
        return timed_result(name, started, "FAIL", f"{type(exc).__name__}: {exc}")


def _cert_name(entries: Iterable[tuple[tuple[str, str], ...]]) -> str:
    parts: list[str] = []
    for group in entries:
        for key, value in group:
            if key in ("commonName", "organizationName"):
                parts.append(f"{key}={value}")
    return ", ".join(parts) or "unknown"


def test_tls(host: str, port: int, timeout: float) -> Result:
    """Validate the TLS certificate exactly as a normal trusted client would."""
    name = f"TLS {host}:{port}"
    started = time.monotonic()
    try:
        context = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=timeout) as raw:
            with context.wrap_socket(raw, server_hostname=host) as tls:
                cert = tls.getpeercert()
                protocol = tls.version() or "unknown"
                cipher = (tls.cipher() or ("unknown",))[0]
        subject = _cert_name(cert.get("subject", ()))
        issuer = _cert_name(cert.get("issuer", ()))
        expires = cert.get("notAfter", "unknown")
        detail = f"{protocol}, {cipher}; subject={subject}; issuer={issuer}; expires={expires}"
        return timed_result(name, started, "PASS", detail)
    except ssl.SSLCertVerificationError as exc:
        return timed_result(name, started, "FAIL", f"certificate verification failed: {exc}")
    except ssl.SSLError as exc:
        return timed_result(name, started, "FAIL", f"TLS handshake failed: {exc}")
    except Exception as exc:
        return timed_result(name, started, "FAIL", f"{type(exc).__name__}: {exc}")


def stun_request(transaction_id: bytes) -> bytes:
    # RFC 8489: 20-byte header = type, length, magic cookie, 96-bit random txid.
    return struct.pack("!HHI12s", STUN_BINDING_REQUEST, 0, MAGIC_COOKIE, transaction_id)


def parse_stun_attributes(data: bytes) -> dict[int, list[bytes]]:
    attrs: dict[int, list[bytes]] = {}
    if len(data) < 20:
        return attrs
    message_length = struct.unpack_from("!H", data, 2)[0]
    end = min(len(data), 20 + message_length)
    offset = 20
    while offset + 4 <= end:
        attr_type, attr_len = struct.unpack_from("!HH", data, offset)
        value_start = offset + 4
        value_end = value_start + attr_len
        if value_end > end:
            break
        attrs.setdefault(attr_type, []).append(data[value_start:value_end])
        offset = value_end + ((4 - (attr_len % 4)) % 4)
    return attrs


def parse_error_code(value: bytes) -> Optional[int]:
    if len(value) < 4:
        return None
    return (value[2] & 0x07) * 100 + value[3]


def decode_mapped_address(value: bytes, transaction_id: bytes, xor: bool) -> Optional[str]:
    if len(value) < 4:
        return None
    family = value[1]
    port = struct.unpack_from("!H", value, 2)[0]
    if xor:
        port ^= (MAGIC_COOKIE >> 16)

    if family == 0x01 and len(value) >= 8:  # IPv4
        raw = bytearray(value[4:8])
        if xor:
            cookie = struct.pack("!I", MAGIC_COOKIE)
            raw = bytearray(a ^ b for a, b in zip(raw, cookie))
        return f"{socket.inet_ntop(socket.AF_INET, bytes(raw))}:{port}"

    if family == 0x02 and len(value) >= 20:  # IPv6
        raw = bytearray(value[4:20])
        if xor:
            mask = struct.pack("!I", MAGIC_COOKIE) + transaction_id
            raw = bytearray(a ^ b for a, b in zip(raw, mask))
        return f"[{socket.inet_ntop(socket.AF_INET6, bytes(raw))}]:{port}"
    return None


def test_stun_udp(host: str, port: int, timeout: float) -> Result:
    name = f"STUN/UDP {host}:{port}"
    started = time.monotonic()
    txid = secrets.token_bytes(12)
    request = stun_request(txid)
    errors: list[str] = []

    try:
        targets = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)
    except Exception as exc:
        return timed_result(name, started, "FAIL", f"DNS: {type(exc).__name__}: {exc}")

    for family, socktype, proto, _, sockaddr in targets:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        sock = socket.socket(family, socktype, proto)
        try:
            sock.settimeout(timeout)
            sock.sendto(request, sockaddr)
            data, peer = sock.recvfrom(4096)
            if len(data) < 20:
                errors.append(f"{peer}: short response ({len(data)} bytes)")
                continue

            msg_type, msg_len, cookie = struct.unpack_from("!HHI", data, 0)
            response_txid = data[8:20]
            if cookie != MAGIC_COOKIE:
                errors.append(f"{peer}: wrong STUN magic cookie")
                continue
            if response_txid != txid:
                errors.append(f"{peer}: transaction ID mismatch")
                continue
            if len(data) < 20 + msg_len:
                errors.append(f"{peer}: truncated STUN response")
                continue

            attrs = parse_stun_attributes(data)
            if msg_type == STUN_BINDING_SUCCESS:
                mapped = None
                if ATTR_XOR_MAPPED_ADDRESS in attrs:
                    mapped = decode_mapped_address(attrs[ATTR_XOR_MAPPED_ADDRESS][0], txid, True)
                elif ATTR_MAPPED_ADDRESS in attrs:
                    mapped = decode_mapped_address(attrs[ATTR_MAPPED_ADDRESS][0], txid, False)
                detail = f"valid Binding success from {peer[0]}:{peer[1]}"
                if mapped:
                    detail += f"; mapped address={mapped}"
                return timed_result(name, started, "PASS", detail)

            if msg_type == STUN_BINDING_ERROR:
                code = None
                if ATTR_ERROR_CODE in attrs:
                    code = parse_error_code(attrs[ATTR_ERROR_CODE][0])
                errors.append(f"{peer}: STUN error {code or 'unknown'}")
            else:
                errors.append(f"{peer}: unexpected STUN message type 0x{msg_type:04x}")
        except socket.timeout:
            errors.append(f"{sockaddr[0]}:{port}: timeout")
        except Exception as exc:
            errors.append(f"{sockaddr[0]}:{port}: {type(exc).__name__}: {exc}")
        finally:
            sock.close()

    return timed_result(name, started, "FAIL", "; ".join(errors) or "no usable address")


def test_stun_tcp(host: str, port: int, timeout: float) -> Result:
    """Test STUN Binding over TCP (RFC 5389/RFC 8489).
    
    STUN over TCP uses the same message format as UDP, but with a 2-byte
    length prefix before each STUN message (framing).
    """
    name = f"STUN/TCP {host}:{port}"
    started = time.monotonic()
    txid = secrets.token_bytes(12)
    stun_msg = stun_request(txid)
    # TCP framing: 2-byte length (big-endian) + STUN message
    request = struct.pack("!H", len(stun_msg)) + stun_msg
    errors: list[str] = []

    try:
        targets = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except Exception as exc:
        return timed_result(name, started, "FAIL", f"DNS: {type(exc).__name__}: {exc}")

    for family, socktype, proto, _, sockaddr in targets:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        sock = socket.socket(family, socktype, proto)
        try:
            sock.settimeout(timeout)
            sock.connect(sockaddr)
            sock.sendall(request)
            
            # Read the 2-byte length prefix
            length_prefix = sock.recv(2)
            if len(length_prefix) < 2:
                errors.append(f"{sockaddr[0]}:{port}: short length prefix ({len(length_prefix)} bytes)")
                continue
            msg_len = struct.unpack("!H", length_prefix)[0]
            
            # Read the STUN message body
            data = sock.recv(msg_len)
            if len(data) < msg_len:
                errors.append(f"{sockaddr[0]}:{port}: short message ({len(data)}/{msg_len} bytes)")
                continue
            if len(data) < 20:
                errors.append(f"{sockaddr[0]}:{port}: STUN message too short ({len(data)} bytes)")
                continue

            msg_type, _, cookie = struct.unpack_from("!HHI", data, 0)
            response_txid = data[8:20]
            if cookie != MAGIC_COOKIE:
                errors.append(f"{sockaddr[0]}:{port}: wrong STUN magic cookie")
                continue
            if response_txid != txid:
                errors.append(f"{sockaddr[0]}:{port}: transaction ID mismatch")
                continue
            if len(data) < 20 + msg_len:
                errors.append(f"{sockaddr[0]}:{port}: truncated STUN response")
                continue

            attrs = parse_stun_attributes(data)
            if msg_type == STUN_BINDING_SUCCESS:
                mapped = None
                if ATTR_XOR_MAPPED_ADDRESS in attrs:
                    mapped = decode_mapped_address(attrs[ATTR_XOR_MAPPED_ADDRESS][0], txid, True)
                elif ATTR_MAPPED_ADDRESS in attrs:
                    mapped = decode_mapped_address(attrs[ATTR_MAPPED_ADDRESS][0], txid, False)
                detail = f"valid Binding success from {sockaddr[0]}:{port}"
                if mapped:
                    detail += f"; mapped address={mapped}"
                return timed_result(name, started, "PASS", detail)

            if msg_type == STUN_BINDING_ERROR:
                code = None
                if ATTR_ERROR_CODE in attrs:
                    code = parse_error_code(attrs[ATTR_ERROR_CODE][0])
                errors.append(f"{sockaddr[0]}:{port}: STUN error {code or 'unknown'}")
            else:
                errors.append(f"{sockaddr[0]}:{port}: unexpected STUN message type 0x{msg_type:04x}")
        except socket.timeout:
            errors.append(f"{sockaddr[0]}:{port}: timeout")
        except Exception as exc:
            errors.append(f"{sockaddr[0]}:{port}: {type(exc).__name__}: {exc}")
        finally:
            sock.close()

    return timed_result(name, started, "FAIL", "; ".join(errors) or "no usable address")


def test_stun_tls(host: str, port: int, timeout: float) -> Result:
    """Test STUN Binding over TLS (STUNS, RFC 5389/RFC 8489).
    
    STUN over TLS uses TCP framing (2-byte length prefix) wrapped in TLS.
    """
    name = f"STUN/TLS {host}:{port}"
    started = time.monotonic()
    txid = secrets.token_bytes(12)
    stun_msg = stun_request(txid)
    # TCP framing: 2-byte length (big-endian) + STUN message
    request = struct.pack("!H", len(stun_msg)) + stun_msg
    errors: list[str] = []

    try:
        targets = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except Exception as exc:
        return timed_result(name, started, "FAIL", f"DNS: {type(exc).__name__}: {exc}")

    for family, socktype, proto, _, sockaddr in targets:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        sock = socket.socket(family, socktype, proto)
        try:
            sock.settimeout(timeout)
            sock.connect(sockaddr)
            context = ssl.create_default_context()
            with context.wrap_socket(sock, server_hostname=host) as tls:
                tls.sendall(request)
                
                # Read the 2-byte length prefix
                length_prefix = tls.recv(2)
                if len(length_prefix) < 2:
                    errors.append(f"{sockaddr[0]}:{port}: short length prefix ({len(length_prefix)} bytes)")
                    continue
                msg_len = struct.unpack("!H", length_prefix)[0]
                
                # Read the STUN message body
                data = tls.recv(msg_len)
                if len(data) < msg_len:
                    errors.append(f"{sockaddr[0]}:{port}: short message ({len(data)}/{msg_len} bytes)")
                    continue
                if len(data) < 20:
                    errors.append(f"{sockaddr[0]}:{port}: STUN message too short ({len(data)} bytes)")
                    continue

                msg_type, _, cookie = struct.unpack_from("!HHI", data, 0)
                response_txid = data[8:20]
                if cookie != MAGIC_COOKIE:
                    errors.append(f"{sockaddr[0]}:{port}: wrong STUN magic cookie")
                    continue
                if response_txid != txid:
                    errors.append(f"{sockaddr[0]}:{port}: transaction ID mismatch")
                    continue
                if len(data) < 20 + msg_len:
                    errors.append(f"{sockaddr[0]}:{port}: truncated STUN response")
                    continue

                attrs = parse_stun_attributes(data)
                if msg_type == STUN_BINDING_SUCCESS:
                    mapped = None
                    if ATTR_XOR_MAPPED_ADDRESS in attrs:
                        mapped = decode_mapped_address(attrs[ATTR_XOR_MAPPED_ADDRESS][0], txid, True)
                    elif ATTR_MAPPED_ADDRESS in attrs:
                        mapped = decode_mapped_address(attrs[ATTR_MAPPED_ADDRESS][0], txid, False)
                    detail = f"valid Binding success from {sockaddr[0]}:{port}"
                    if mapped:
                        detail += f"; mapped address={mapped}"
                    return timed_result(name, started, "PASS", detail)

                if msg_type == STUN_BINDING_ERROR:
                    code = None
                    if ATTR_ERROR_CODE in attrs:
                        code = parse_error_code(attrs[ATTR_ERROR_CODE][0])
                    errors.append(f"{sockaddr[0]}:{port}: STUN error {code or 'unknown'}")
                else:
                    errors.append(f"{sockaddr[0]}:{port}: unexpected STUN message type 0x{msg_type:04x}")
        except ssl.SSLCertVerificationError as exc:
            errors.append(f"{sockaddr[0]}:{port}: TLS cert verification failed: {exc}")
        except ssl.SSLError as exc:
            errors.append(f"{sockaddr[0]}:{port}: TLS handshake failed: {exc}")
        except socket.timeout:
            errors.append(f"{sockaddr[0]}:{port}: timeout")
        except Exception as exc:
            errors.append(f"{sockaddr[0]}:{port}: {type(exc).__name__}: {exc}")
        finally:
            try:
                sock.close()
            except Exception:
                pass

    return timed_result(name, started, "FAIL", "; ".join(errors) or "no usable address")


def rest_credentials(secret: str, user_id: str, ttl: int) -> tuple[str, str]:
    expiry = int(time.time()) + ttl
    username = f"{expiry}:{user_id}"
    digest = hmac.new(secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1).digest()
    password = base64.b64encode(digest).decode("ascii")
    return username, password


def parse_version_tuple(value: str) -> tuple[int, ...]:
    parts: list[int] = []
    for token in value.split("."):
        number = ""
        for ch in token:
            if ch.isdigit():
                number += ch
            else:
                break
        if not number:
            break
        parts.append(int(number))
    return tuple(parts)


def load_aioice() -> tuple[Any, Optional[str]]:
    try:
        import aioice  # type: ignore
        try:
            from importlib.metadata import version
            installed = version("aioice")
        except Exception:
            installed = getattr(aioice, "__version__", "unknown")
        return aioice, installed
    except ImportError:
        return None, None


def candidate_text(candidate: Any) -> str:
    related = ""
    related_addr = getattr(candidate, "related_address", None)
    related_port = getattr(candidate, "related_port", None)
    if related_addr:
        related = f" (related {related_addr}:{related_port})"
    return f"{candidate.host}:{candidate.port}/{candidate.transport}{related}"


async def test_turn_allocation(
    aioice: Any,
    host: str,
    port: int,
    transport: str,
    use_tls: bool,
    username: str,
    password: str,
    timeout: float,
) -> Result:
    scheme = "TURNS/TCP" if use_tls else f"TURN/{transport.upper()}"
    name = f"{scheme} allocation {host}:{port}"
    started = time.monotonic()
    conn = None
    try:
        conn = aioice.Connection(
            ice_controlling=True,
            turn_server=(host, port),
            turn_username=username,
            turn_password=password,
            turn_ssl=use_tls,
            turn_transport=transport,
        )
        await asyncio.wait_for(conn.gather_candidates(), timeout=timeout)
        relay = [c for c in conn.local_candidates if getattr(c, "type", None) == "relay"]
        if not relay:
            all_types = sorted({getattr(c, "type", "?") for c in conn.local_candidates})
            return timed_result(name, started, "FAIL", f"no relay candidate; gathered types={all_types}")
        return timed_result(name, started, "PASS", ", ".join(candidate_text(c) for c in relay))
    except asyncio.TimeoutError:
        return timed_result(name, started, "FAIL", f"timed out after {timeout:g}s")
    except Exception as exc:
        return timed_result(name, started, "FAIL", f"{type(exc).__name__}: {exc}")
    finally:
        if conn is not None:
            try:
                await conn.close()
            except Exception:
                pass


async def test_relay_data(
    aioice: Any,
    host: str,
    port: int,
    transport: str,
    use_tls: bool,
    creds_a: tuple[str, str],
    creds_b: tuple[str, str],
    timeout: float,
) -> Result:
    """Create two ICE agents and exchange only relay candidates, then send data."""
    scheme = "TURNS/TCP" if use_tls else f"TURN/{transport.upper()}"
    name = f"{scheme} relay data {host}:{port}"
    started = time.monotonic()
    a = b = None
    try:
        a = aioice.Connection(
            ice_controlling=True,
            turn_server=(host, port),
            turn_username=creds_a[0],
            turn_password=creds_a[1],
            turn_ssl=use_tls,
            turn_transport=transport,
        )
        b = aioice.Connection(
            ice_controlling=False,
            turn_server=(host, port),
            turn_username=creds_b[0],
            turn_password=creds_b[1],
            turn_ssl=use_tls,
            turn_transport=transport,
        )

        await asyncio.wait_for(asyncio.gather(a.gather_candidates(), b.gather_candidates()), timeout=timeout)
        a_relay = [c for c in a.local_candidates if getattr(c, "type", None) == "relay"]
        b_relay = [c for c in b.local_candidates if getattr(c, "type", None) == "relay"]
        if not a_relay or not b_relay:
            return timed_result(name, started, "FAIL", "could not obtain two relay candidates")

        a.remote_username, a.remote_password = b.local_username, b.local_password
        b.remote_username, b.remote_password = a.local_username, a.local_password

        for candidate in b_relay:
            await a.add_remote_candidate(candidate)
        await a.add_remote_candidate(None)
        for candidate in a_relay:
            await b.add_remote_candidate(candidate)
        await b.add_remote_candidate(None)

        await asyncio.wait_for(asyncio.gather(a.connect(), b.connect()), timeout=timeout)

        payload = b"turn-diag-" + secrets.token_bytes(8)
        await a.send(payload)
        received = await asyncio.wait_for(b.recv(), timeout=timeout)
        if received != payload:
            return timed_result(name, started, "FAIL", "ICE connected, but relay payload did not match")
        return timed_result(name, started, "PASS", "two relay-only ICE agents connected and exchanged a datagram")
    except asyncio.TimeoutError:
        return timed_result(name, started, "FAIL", f"timed out after {timeout:g}s")
    except Exception as exc:
        return timed_result(name, started, "FAIL", f"{type(exc).__name__}: {exc}")
    finally:
        for conn in (a, b):
            if conn is not None:
                try:
                    await conn.close()
                except Exception:
                    pass


def print_result(result: Result) -> None:
    print(f"[{result.status:<4}] {result.name:<44} {result.detail} ({result.elapsed_ms:.1f} ms)")


# ---------------------------------------------------------------------------
# WMS device registration / checkin / WebRTC credential retrieval
# ---------------------------------------------------------------------------

def _rand_mac() -> str:
    """Generate a random MAC address string (hex, no separators)."""
    return "".join(f"{random.randint(0, 255):02x}" for _ in range(6))


def _rand_ip() -> str:
    """Generate a random private-ish IP address."""
    return f"10.{random.randint(1, 254)}.{random.randint(1, 254)}.{random.randint(1, 254)}"


def _rand_serial(length: int = 11) -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=length))


def _normalize_wms_url(url: str) -> str:
    """Ensure URL has https:// scheme and /ccm-web path suffix."""
    url = url.strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    if not url.endswith("/ccm-web"):
        url = url.rstrip("/") + "/ccm-web"
    return url


def _device_payload(person_id: int, serial: str, ip: str, mac: str) -> dict:
    """Build the JSON payload accepted by both /open/deviceRegister and /device/checkin."""
    return {
        "wmsConfig": "WMS20",
        "agentCryptoVersion": 3,
        "hashVersion": 2,
        "isBlobSupported": True,
        "currentlyLoggedInUser": "turndiag\\user",
        "brokerServer": {
            "type": "None", "url": "none",
            "logonusers": [{"username": "turndiag\\user",
                            "logintime": "2024-06-12T08:41:21.725Z"}],
        },
        "isDiskLoggingEnabled": False,
        "owner": {"id": person_id},
        "ccmAgentVersion": "5.0.0.5",
        "deviceType": {"type": 6, "family": 6},
        "deviceOsType": {"type": 9, "description": "WTOS"},
        "osBuildVersion": "2402 (9.5.1079)",
        "modelName": "Latitude 5440",
        "deviceTypeDesc": "Thin OS (Latitude 5440)",
        "modelId": "Latitude5440",
        "devicePlatformType": {
            "oem": 0, "hardware": 2, "type": 0,
            "description": "Latitude 5440", "modelCode": "0C00",
        },
        "name": "TurnDiag-Device",
        "cpuFamily": "13th Gen Intel(R) Core(TM) i5-1345U @ 2.49 GHz",
        "storages": [{"totalSpace": 226174, "availableSpace": 220096, "mountedPath": "/"}],
        "serialNum": serial,
        "tags": "N/A",
        "uptime": "1D 0:0:0",
        "locale": "English",
        "timezoneName": "UTC",
        "keyboardLayout": "US",
        "hardwareSummary": {
            "cpu": "2.49 GHz", "cpuSpeed": "2.49 GHz",
            "memory": "16360068", "bios": "1.5.0",
        },
        "macAddress": mac,
        "ip": ip,
        "networkInterfaces": [{
            "name": "ENET0", "ip": ip,
            "subnetmask": "255.255.255.0", "gateway": "10.0.0.1",
            "dns1": "10.0.0.5", "dns2": "N/A",
            "mac": mac, "isDhcp": "true", "isCurrent": 1,
        }],
        "deviceCurrentSetting": {
            "timeServers": "pool.ntp.org",
            "privilageLevel": "High",
            "dualHeadMode": "mirror",
        },
        "largeLogUpload": True,
    }


# _device_payload is used for both register and checkin (same payload, matching working scripts)


def _decrypt_aes_ctr(encrypted_b64: str, aes_key_b64: str, iv_length: int = 16) -> str:
    """Decrypt AES-CTR encrypted Base64 string.  Layout: IV || ciphertext."""
    try:
        from Crypto.Cipher import AES as _AES
    except ImportError:
        from Cryptodome.Cipher import AES as _AES  # type: ignore[no-redef]
    key = base64.b64decode(aes_key_b64)
    raw = base64.b64decode(encrypted_b64)
    iv = raw[:iv_length]
    ciphertext = raw[iv_length:]
    cipher = _AES.new(key, _AES.MODE_CTR, nonce=b"", initial_value=int.from_bytes(iv, "big"))
    return cipher.decrypt(ciphertext).decode("utf-8")


def _decrypt_webrtc_fields(response_json: dict, aes_key_b64: str) -> dict:
    """Decrypt every field in the getWebRTCDetails response and strip salt prefix."""
    decrypted: dict = {}
    for key, encrypted_value in response_json.items():
        try:
            plain = _decrypt_aes_ctr(encrypted_value, aes_key_b64, iv_length=16)
            # Strip the leading base64-salt that ends with '=='
            parts = plain.split("==", 1)
            decrypted[key] = parts[1] if len(parts) == 2 else plain
        except Exception as exc:
            decrypted[key] = f"<decryption failed: {exc}>"
    return decrypted


def _import_requests():
    """Lazy-import requests so the script stays usable without it for manual mode."""
    try:
        import requests as _req
        import urllib3 as _u3
        _u3.disable_warnings(_u3.exceptions.InsecureRequestWarning)
        return _req
    except ImportError:
        raise SystemExit(
            "ERROR: 'requests' package is required for WMS mode.\n"
            "       Install with: python -m pip install requests"
        )


def wms_acquire_turn_credentials(
    wms_url: str,
    group_token: str,
    timeout: float = 30.0,
) -> Tuple[dict, list[Result]]:
    """Register a device, check it in, and fetch TURN credentials from WMS.

    Returns (webrtc_details_dict, list_of_Result).
    webrtc_details_dict keys typically: turnServerURL, userID, phrase,
                                        stunServerURL, stunServerPort, etc.
    """
    requests = _import_requests()
    results: list[Result] = []
    session = requests.Session()
    session.verify = False

    mac = _rand_mac()
    ip = _rand_ip()
    serial = _rand_serial()
    device_name = "TurnDiag-Device"

    # ── Step 1: Pre-register (get PersonID) ──────────────────────────────
    step = "WMS pre-register"
    started = time.monotonic()
    try:
        grp_payload = json.dumps({
            "_id": None, "createdAt": None, "id": 0,
            "updatedAt": None, "isActive": True,
            "groupToken": group_token,
        })
        resp = session.post(
            wms_url + "/open/deviceGroupLogin",
            data=grp_payload,
            headers={"Content-type": "application/json;charset=UTF-8"},
            timeout=timeout,
            allow_redirects=False,
        )
        if resp.status_code != 200:
            results.append(timed_result(step, started, "FAIL",
                           f"HTTP {resp.status_code}: {resp.text[:200]}"))
            return {}, results
        person_id = resp.json()["id"]
        results.append(timed_result(step, started, "PASS", f"PersonID={person_id}"))
    except Exception as exc:
        results.append(timed_result(step, started, "FAIL", f"{type(exc).__name__}: {exc}"))
        return {}, results

    # ── Step 2: Register device ──────────────────────────────────────────
    step = "WMS device register"
    started = time.monotonic()
    try:
        reg_payload = json.dumps(_device_payload(person_id, serial, ip, mac))
        resp = session.post(
            wms_url + "/open/deviceRegister",
            data=reg_payload,
            headers={
                "Content-type": "application/json;charset=UTF-8",
                "X-Stratus-device-owner-id": str(person_id),
            },
            timeout=timeout,
            allow_redirects=False,
        )
        if resp.status_code != 200:
            results.append(timed_result(step, started, "FAIL",
                           f"HTTP {resp.status_code}: {resp.text[:300]}"))
            return {}, results
        reg_out = resp.json()
        wid = reg_out["wyseIdentifier"]
        auth_code = reg_out["authenticationCode"]
        results.append(timed_result(step, started, "PASS",
                       f"WID={wid}, serial={serial}, mac={mac}"))
    except Exception as exc:
        results.append(timed_result(step, started, "FAIL", f"{type(exc).__name__}: {exc}"))
        return {}, results

    # ── Build auth header used for checkin / getKey / getWebRTCDetails ───
    current_milli = int(time.time()) * 1000
    token_raw = str(wid) + str(current_milli) + str(auth_code)
    md5 = hashlib.md5(token_raw.encode("utf-8")).digest()
    final_token = base64.encodebytes(md5).decode("ascii").strip()

    from datetime import datetime, timezone
    utc_now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    device_header = {
        "Content-type": "application/json;charset=UTF-8",
        "X-Stratus-date": utc_now,
        "User-Agent": "Stratus /5.0.0.5  (DellThinOS 9.5.3007; utf-8;  Latitude 5440;  Revision:12.3.432.1:  ; cls: D )",
        "X-Stratus-device-authentication-code": final_token,
        "X-Stratus-device-id": wid,
    }

    # ── Step 3: Device check-in ──────────────────────────────────────────
    step = "WMS device checkin"
    started = time.monotonic()
    try:
        checkin_payload = json.dumps(_device_payload(person_id, serial, ip, mac))
        resp = session.post(
            wms_url + "/device/checkin",
            data=checkin_payload,
            headers=device_header,
            timeout=timeout,
            allow_redirects=False,
        )
        if resp.status_code == 200:
            results.append(timed_result(step, started, "PASS", f"HTTP 200"))
        else:
            results.append(timed_result(step, started, "WARN",
                           f"HTTP {resp.status_code} (non-fatal, continuing)"))
    except Exception as exc:
        results.append(timed_result(step, started, "WARN", f"{type(exc).__name__}: {exc} (continuing)"))

    # ── Step 4: Get device encryption key ────────────────────────────────
    step = "WMS getKey"
    started = time.monotonic()
    try:
        resp = session.get(
            wms_url + f"/device/getKey?wyseId={wid}",
            headers=device_header,
            timeout=timeout,
            allow_redirects=False,
        )
        if resp.status_code != 200:
            results.append(timed_result(step, started, "FAIL",
                           f"HTTP {resp.status_code}: {resp.text[:200]}"))
            return {}, results
        device_enc_key = resp.text.strip()
        results.append(timed_result(step, started, "PASS",
                       f"key={device_enc_key[:8]}...{device_enc_key[-4:]}"))
    except Exception as exc:
        results.append(timed_result(step, started, "FAIL", f"{type(exc).__name__}: {exc}"))
        return {}, results

    # ── Step 5: Get encrypted WebRTC details and decrypt ─────────────────
    step = "WMS getWebRTCDetails"
    started = time.monotonic()
    try:
        resp = session.get(
            wms_url + "/device/getWebRTCDetails",
            headers=device_header,
            timeout=timeout,
            allow_redirects=False,
        )
        if resp.status_code != 200:
            results.append(timed_result(step, started, "FAIL",
                           f"HTTP {resp.status_code}: {resp.text[:200]}"))
            return {}, results
        encrypted_json = resp.json()
        webrtc = _decrypt_webrtc_fields(encrypted_json, device_enc_key)
        results.append(timed_result(step, started, "PASS",
                       f"turnURL={webrtc.get('turnServerURL', 'N/A')}, "
                       f"stunURL={webrtc.get('turnServerURL', 'N/A')}"))
    except Exception as exc:
        results.append(timed_result(step, started, "FAIL", f"{type(exc).__name__}: {exc}"))
        return {}, results
    finally:
        session.close()

    return webrtc, results


def _parse_turn_url(turn_url: str) -> Tuple[str, int, bool]:
    """Parse a TURN URL like 'turns:host:port' or 'turn:host:port' into (host, port, is_tls)."""
    turn_url = turn_url.strip()
    # Handle formats: turns:host:port, turn:host:port, host:port, host
    m = re.match(r"^(turns?)?:?/*([^:/]+):?(\d+)?$", turn_url)
    if not m:
        # fallback: try splitting on colon
        parts = turn_url.replace("turn:", "").replace("turns:", "").strip("/").split(":")
        host = parts[0]
        port = int(parts[1]) if len(parts) > 1 else 3478
        is_tls = "turns" in turn_url.lower()
        return host, port, is_tls
    scheme = m.group(1) or ""
    host = m.group(2)
    port = int(m.group(3)) if m.group(3) else (443 if scheme == "turns" else 3478)
    is_tls = scheme.lower() == "turns" if scheme else False
    return host, port, is_tls


def _parse_stun_url(stun_url: str) -> Tuple[str, int]:
    """Parse a STUN URL like 'stun:host:port' into (host, port)."""
    stun_url = stun_url.strip().replace("stun:", "").replace("stuns:", "").strip("/")
    parts = stun_url.split(":")
    host = parts[0]
    port = int(parts[1]) if len(parts) > 1 else 3478
    return host, port


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Test coturn from the network this machine is currently using.\n"
                    "Optionally register a device on a WMS server to obtain TURN credentials automatically.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--host", default=os.getenv("TURN_HOST", "coturn.ad80.com"))
    parser.add_argument("--plain-port", type=int, default=int(os.getenv("TURN_PORT", "3478")), help="plain TURN UDP/TCP port")
    parser.add_argument("--tls-port", type=int, default=int(os.getenv("TURNS_PORT", "443")), help="TURN TLS-over-TCP port")
    parser.add_argument("--stun-port", type=int, default=None, help="plain STUN/UDP port; defaults to --plain-port")
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--ttl", type=int, default=3600, help="REST credential lifetime in seconds")
    parser.add_argument("--user-id", default="turn-diag")

    auth = parser.add_argument_group("authentication")
    auth.add_argument("--secret", default=os.getenv("TURN_SECRET"), help="coturn static-auth-secret (prefer TURN_SECRET env var)")
    auth.add_argument("--username", default=os.getenv("TURN_USERNAME"), help="fixed TURN username instead of shared secret")
    auth.add_argument("--password", default=os.getenv("TURN_PASSWORD"), help="fixed TURN password instead of shared secret")

    wms = parser.add_argument_group("WMS integration (overrides manual auth)")
    wms.add_argument("--wms-url", default=None,
                     help="WMS server base URL, e.g. https://myserver.com/ccm-web")
    wms.add_argument("--group-token", default=None,
                     help="WMS group registration token")

    parser.add_argument("--skip-udp", action="store_true", help="skip TURN/UDP allocation and STUN/UDP test")
    parser.add_argument("--skip-tcp", action="store_true", help="skip plain TURN/TCP allocation and STUN/TCP test")
    parser.add_argument("--skip-tls", action="store_true", help="skip TLS, TURNS/TCP, and STUN/TLS tests")
    parser.add_argument("--skip-stun", action="store_true", help="skip STUN/UDP, STUN/TCP, and STUN/TLS Binding tests")
    parser.add_argument("--skip-relay", action="store_true", help="skip two-client relay-only data tests")

    profiles = parser.add_argument_group("test profiles (shorthands for common skip combinations)")
    profiles.add_argument("--tcp-turn-only", action="store_true", help="shorthand for --skip-stun --skip-udp (test only TURN/TCP and TURNS/TCP)")
    parser.add_argument("--json", action="store_true", help="print JSON instead of human-readable output")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser


async def async_main(args: argparse.Namespace) -> int:
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING)
    results: list[Result] = []

    # ── WMS integration path ─────────────────────────────────────────────
    wms_mode = bool(args.wms_url and args.group_token)
    if wms_mode:
        #print("\n" + "=" * 90)
        #print("WMS MODE: registering device, checking in, fetching TURN credentials from server")
        #print("=" * 90)
        webrtc, wms_results = wms_acquire_turn_credentials(
            args.wms_url, args.group_token, timeout=args.timeout * 4,
        )
        results.extend(wms_results)

        if not webrtc:
            # WMS flow failed — print what we have and exit
            if args.json:
                print(json.dumps({"host": "(wms)", "results": [asdict(r) for r in results]}, indent=2))
            else:
                for r in results:
                    print_result(r)
            return 1

        # Print the decrypted WebRTC details
        #print("\nDecrypted WebRTC details from WMS:")
        #print(json.dumps(webrtc, indent=2))

        # Check for decryption failures
        failed_keys = [k for k, v in webrtc.items() if isinstance(v, str) and v.startswith("<decryption failed")]
        if failed_keys:
            results.append(Result("WMS decrypt", "FAIL",
                           f"could not decrypt fields: {', '.join(failed_keys)}", 0.0))
            if args.json:
                print(json.dumps({"host": "(wms)", "results": [asdict(r) for r in results]}, indent=2))
            else:
                for r in results:
                    print_result(r)
            return 1

        # Override args with server-provided values
        turn_url_raw = webrtc.get("turnServerURL", "")
        stun_url_raw = webrtc.get("turnServerURL", "")

        if turn_url_raw:
            host, port, is_tls = _parse_turn_url(turn_url_raw)
            args.host = host
            if is_tls:
                args.tls_port = port
            else:
                args.plain_port = port
        if stun_url_raw:
            stun_host, stun_port = _parse_stun_url(stun_url_raw)
            args.stun_port = stun_port
            if not turn_url_raw:
                args.host = stun_host

        # Use TURN credentials from server
        args.username = webrtc.get("userID", "")
        args.password = webrtc.get("phrase", "")
        # Clear secret so we use fixed username/password path
        args.secret = None

        print(f"\nUsing TURN host={args.host}, plain_port={args.plain_port}, "
              f"tls_port={args.tls_port}, stun_port={args.stun_port}")
        print(f"TURN username={args.username}")
        print(f"TURN password={args.password if args.password else '(empty)'}")
        print("=" * 90 + "\n")

    # ── Standard diagnostic flow ─────────────────────────────────────────
    results.append(test_dns(args.host))
    if not args.skip_stun and not args.skip_udp:
        results.append(test_stun_udp(args.host, args.stun_port or args.plain_port, args.timeout))
    if not args.skip_stun and not args.skip_tcp:
        results.append(test_stun_tcp(args.host, args.stun_port or args.plain_port, args.timeout))
    if not args.skip_stun and not args.skip_tls:
        results.append(test_stun_tls(args.host, args.tls_port, args.timeout))

    if not args.skip_tcp:
        results.append(test_tcp(args.host, args.plain_port, args.timeout, "plain"))
    if not args.skip_tls:
        results.append(test_tcp(args.host, args.tls_port, args.timeout, "TLS port"))
        results.append(test_tls(args.host, args.tls_port, args.timeout))

    aioice, aioice_version = load_aioice()
    if aioice is None:
        detail = 'install with: python -m pip install "aioice>=0.10.2,<1"'
        if not args.skip_udp:
            results.append(Result("TURN/UDP allocation", "SKIP", detail, 0.0))
        if not args.skip_tcp:
            results.append(Result("TURN/TCP allocation", "SKIP", detail, 0.0))
        if not args.skip_tls:
            results.append(Result("TURNS/TCP allocation", "SKIP", detail, 0.0))
    else:
        if aioice_version and aioice_version != "unknown" and parse_version_tuple(aioice_version) < (0, 10, 2):
            results.append(Result("aioice version", "WARN", f"installed {aioice_version}; upgrade to >=0.10.2", 0.0))

        fixed_auth = bool(args.username or args.password)
        if args.secret and fixed_auth:
            raise SystemExit("Use either --secret (REST auth) OR --username/--password, not both.")
        if fixed_auth and not (args.username and args.password):
            raise SystemExit("Both --username and --password are required for fixed TURN credentials.")

        if args.secret:
            def make_creds(suffix: str = "") -> tuple[str, str]:
                user = args.user_id + suffix
                return rest_credentials(args.secret, user, args.ttl)
        elif args.username and args.password:
            def make_creds(suffix: str = "") -> tuple[str, str]:
                return args.username, args.password
        else:
            def make_creds(suffix: str = "") -> tuple[str, str]:
                return "", ""

        if not (args.secret or (args.username and args.password)):
            results.append(Result("TURN authentication", "SKIP", "set TURN_SECRET or TURN_USERNAME + TURN_PASSWORD", 0.0))
        else:
            # Run sequentially: avoids shared-state races, allocation quota spikes, and ambiguous logs.
            transports: list[tuple[str, int, str, bool]] = []
            if not args.skip_udp:
                transports.append(("udp", args.plain_port, "udp", False))
            if not args.skip_tcp:
                transports.append(("tcp", args.plain_port, "tcp", False))
            if not args.skip_tls:
                transports.append(("tls", args.tls_port, "tcp", True))

            usable: list[tuple[str, int, str, bool]] = []
            for key, port, transport, use_tls in transports:
                creds = make_creds(f"-{key}") if args.secret else make_creds()
                result = await test_turn_allocation(
                    aioice, args.host, port, transport, use_tls, creds[0], creds[1], args.timeout
                )
                results.append(result)
                if result.status == "PASS":
                    usable.append((key, port, transport, use_tls))

            if not args.skip_relay:
                for key, port, transport, use_tls in usable:
                    if args.secret:
                        creds_a = make_creds(f"-{key}-a")
                        creds_b = make_creds(f"-{key}-b")
                    else:
                        creds_a = creds_b = make_creds()
                    results.append(
                        await test_relay_data(
                            aioice, args.host, port, transport, use_tls, creds_a, creds_b, args.timeout
                        )
                    )

    if args.json:
        print(json.dumps({"host": args.host, "results": [asdict(r) for r in results]}, indent=2))
    else:
        print(f"\nTURN diagnostic for {args.host}\n" + "-" * 90)
        for result in results:
            print_result(result)
        print("-" * 90)
        passes = [r for r in results if r.status == "PASS"]
        fails = [r for r in results if r.status == "FAIL"]
        print(f"PASS={len(passes)}  FAIL={len(fails)}  SKIP/WARN={len(results)-len(passes)-len(fails)}")
        if not args.skip_relay:
            print("Relay-data PASS is the strongest result: allocation + ICE checks + relayed datagram worked.")

    return 1 if any(r.status == "FAIL" for r in results if "TURN/" in r.name or "TURNS/" in r.name) else 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    # Apply profile shorthands
    if args.tcp_turn_only:
        args.skip_stun = True
        args.skip_udp = True

    # Validate WMS args
    if (args.wms_url is None) != (args.group_token is None):
        parser.error("--wms-url and --group-token must be provided together")
    if args.wms_url:
        args.wms_url = _normalize_wms_url(args.wms_url)

    if not (1 <= args.plain_port <= 65535 and 1 <= args.tls_port <= 65535):
        parser.error("ports must be 1..65535")
    if args.stun_port is not None and not 1 <= args.stun_port <= 65535:
        parser.error("--stun-port must be 1..65535")
    if args.timeout <= 0:
        parser.error("--timeout must be > 0")
    if args.ttl <= 0:
        parser.error("--ttl must be > 0")
    return asyncio.run(async_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
