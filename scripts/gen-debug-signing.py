#!/usr/bin/env python3
"""Generate the local debug signing material for the probe app.

The material under ``app/signing/`` (keystore, PEM pair and the password file)
is committed to the repository on purpose: the phone APK and the band RPK must
share one certificate for Xiaomi interconnect to accept them, so a per-machine
key would break the pairing. This script only fills the material in when it is
missing; existing files are left untouched so repeated builds stay reproducible.
"""

from __future__ import annotations

import os
import secrets
import shutil
import string
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SIGNING_DIR = REPO_ROOT / "app" / "signing"
KEYSTORE = SIGNING_DIR / "debug.jks"
PROPERTIES = SIGNING_DIR / "signing.local.properties"
CERT_PEM = SIGNING_DIR / "certificate.pem"
PRIVATE_PEM = SIGNING_DIR / "private.pem"

ALIAS = "minavigatering"
DNAME = "CN=MiNavigateRing Probe"
VALIDITY_DAYS = "3650"


def _tool(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    java_home = os.environ.get("JAVA_HOME")
    if java_home and name == "keytool":
        candidate = Path(java_home) / "bin" / ("keytool.exe" if os.name == "nt" else "keytool")
        if candidate.exists():
            return str(candidate)
    raise SystemExit(f"required tool not found on PATH: {name}")


def _password() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(32))


def _run(argv: list[str]) -> None:
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise SystemExit(f"command failed ({result.returncode}): {' '.join(argv)}")


def main() -> int:
    SIGNING_DIR.mkdir(parents=True, exist_ok=True)

    if KEYSTORE.exists():
        print(f"keystore already present, leaving untouched: {KEYSTORE}")
        return 0

    keytool = _tool("keytool")
    password = _password()

    _run(
        [
            keytool,
            "-genkeypair",
            "-keystore",
            str(KEYSTORE),
            "-storetype",
            "PKCS12",
            "-alias",
            ALIAS,
            "-keyalg",
            "RSA",
            "-keysize",
            "2048",
            "-validity",
            VALIDITY_DAYS,
            "-dname",
            DNAME,
            "-storepass",
            password,
            "-keypass",
            password,
        ]
    )

    PROPERTIES.write_text(
        "storePassword={p}\nkeyPassword={p}\nkeyAlias={a}\n".format(p=password, a=ALIAS),
        encoding="utf-8",
    )

    p12 = SIGNING_DIR / "debug-export.p12"
    _run(
        [
            keytool,
            "-importkeystore",
            "-srckeystore",
            str(KEYSTORE),
            "-srcstoretype",
            "PKCS12",
            "-srcstorepass",
            password,
            "-srcalias",
            ALIAS,
            "-srckeypass",
            password,
            "-destkeystore",
            str(p12),
            "-deststoretype",
            "PKCS12",
            "-deststorepass",
            password,
            "-destkeypass",
            password,
            "-destalias",
            ALIAS,
            "-noprompt",
        ]
    )

    openssl = _tool("openssl")
    _run(
        [
            openssl,
            "pkcs12",
            "-in",
            str(p12),
            "-nodes",
            "-passin",
            f"pass:{password}",
            "-out",
            str(PRIVATE_PEM),
        ]
    )
    _run([openssl, "x509", "-in", str(PRIVATE_PEM), "-out", str(CERT_PEM)])

    p12.unlink(missing_ok=True)
    print(f"generated debug signing material in {SIGNING_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
