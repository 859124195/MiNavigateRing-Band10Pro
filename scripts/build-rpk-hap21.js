"use strict";

// Band 10 PRO build path: produce the band RPK with hap-toolkit 2.1.0.
//
// Run from the repository root:  node scripts/build-rpk-hap21.js
// Read-only check of a real build: node scripts/build-rpk-hap21.js --check
//
// Why a second builder? The original build-rpk.js uses aiot-toolkit 2.0.5, which
// the community has NOT confirmed runs on Xiaomi Smart Band 10 PRO (Vela 5.0 /
// 336x480). The proven path on Band 10 PRO is hap-toolkit 2.1.0 (see the
// "江浙沪离线导航" reference project). Both toolkits consume the same .ux source
// and the same src/manifest.json; this script just swaps the builder and keeps
// the same cert parity rules so the RPK still pairs with the phone APK.
//
// Cert parity (required by Xiaomi interconnect): the RPK must be signed with the
// same certificate as the phone APK. gen-debug-signing.py writes
// app/signing/{private.pem,certificate.pem} (derived from the same key as
// app/signing/debug.jks the APK is signed with). We copy those PEMs into
// band-app/sign/debug/ so hap-toolkit signs with them, then prove the copy is
// byte-identical. We never generate a new key.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const bandApp = path.join(repoRoot, "band-app");
const signingDir = path.join(repoRoot, "app", "signing");
const privSrc = path.join(signingDir, "private.pem");
const certSrc = path.join(signingDir, "certificate.pem");
const privDest = path.join(bandApp, "sign", "debug", "private.pem");
const certDest = path.join(bandApp, "sign", "debug", "certificate.pem");
const manSrc = path.join(bandApp, "src", "manifest.json");
const hapBin = path.join(bandApp, "node_modules", "hap-toolkit", "bin", "index.js");
const logoTarget = path.join(bandApp, "src", "logo.png");
const recordPath = path.join(bandApp, "dist", "rpk-hap21-build-record.json");

const BUILD_ARGV = "node scripts/build-rpk-hap21.js";
const EXPECTED_MIN_PLATFORM = 1000; // Band 10 PRO / Vela 5.0

// ---------------------------------------------------------------------------
// helpers (mirrors scripts/build-rpk.js)
// ---------------------------------------------------------------------------

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// 192x192 8-bit RGBA transparent round badge with a green left-turn arrow; the
// official manifest icon must be 192x192.
function writeLogo(target) {
  const W = 192;
  const H = 192;
  const CX = 96;
  const CY = 96;
  const R = 68;
  const BG = [23, 38, 30, 255];
  const GREEN = [0, 255, 153, 255];
  const SCALE = 0.67;
  const arrowX = (x) => CX + (x - 89) * SCALE;
  const arrowY = (y) => CY + (y - 96) * SCALE;
  const tipX = arrowX(28);
  const baseX = arrowX(70);
  const shaftEndX = arrowX(150);
  const baseHalf = (144 - 96) * SCALE;
  const shaftTop = arrowY(78);
  const shaftBottom = arrowY(114);

  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < W; x++) {
      const dist = Math.hypot(x - CX, y - CY);
      let alpha;
      if (dist <= R - 0.5) alpha = 255;
      else if (dist >= R + 0.5) alpha = 0;
      else alpha = Math.round(255 * (R + 0.5 - dist));
      if (alpha === 0) continue;
      let px = BG;
      if (x >= baseX && x <= shaftEndX && y >= shaftTop && y <= shaftBottom) px = GREEN;
      if (x >= tipX && x <= baseX) {
        const halfH = ((x - tipX) * baseHalf) / (baseX - tipX);
        if (Math.abs(y - CY) <= halfH) px = GREEN;
      }
      const off = rowStart + 1 + x * 4;
      raw[off] = px[0];
      raw[off + 1] = px[1];
      raw[off + 2] = px[2];
      raw[off + 3] = alpha;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
  fs.writeFileSync(target, png);
}

function loadAdmZip() {
  try {
    return require(path.join(bandApp, "node_modules", "adm-zip"));
  } catch (err) {
    const npmCli = findNpmCli();
    if (!npmCli) return null;
    const r = spawnSync(process.execPath, [npmCli, "install", "--no-save", "adm-zip"], {
      cwd: bandApp,
      shell: false,
      encoding: "utf8",
      timeout: 180000
    });
    if (r.error || r.status !== 0) return null;
    try {
      return require(path.join(bandApp, "node_modules", "adm-zip"));
    } catch (e) {
      return null;
    }
  }
}

function findNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function fail(message, hapExitCode, usedProjectCert, versionName, versionCode) {
  const record = {
    result: "failure",
    argv: BUILD_ARGV,
    hapExitCode: Number.isInteger(hapExitCode) ? hapExitCode : null,
    rpkPath: null,
    bytes: null,
    sha256: null,
    versionName: versionName === undefined ? null : versionName,
    versionCode: versionCode === undefined ? null : versionCode,
    usedProjectCert: !!usedProjectCert,
    message
  };
  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  } catch (e) {}
  console.error(JSON.stringify(record, null, 2));
  process.exit(1);
}

function writeRecord(record) {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const json = JSON.stringify(record, null, 2);
  fs.writeFileSync(recordPath, json + "\n");
  return json;
}

// --check: rebuild and confirm the record + RPK facts match the current source.
if (process.argv.includes("--check")) {
  const before = fs.readFileSync(recordPath);
  const child = spawnSync(process.execPath, [__filename], {
    cwd: repoRoot,
    shell: false,
    encoding: "utf8",
    timeout: 300000
  });
  const after = fs.readFileSync(recordPath);
  if (!before.equals(after)) {
    console.error("[build-rpk-hap21] --check: record changed during the build");
    process.exit(1);
  }
  if (child.status !== 0) {
    console.error("[build-rpk-hap21] --check: child build exited " + child.status);
    process.exit(1);
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch (e) {
    console.error("[build-rpk-hap21] --check: cannot read record");
    process.exit(1);
  }
  if (record.result !== "success") {
    console.error('[build-rpk-hap21] --check: result "' + record.result + '"');
    process.exit(1);
  }
  let man;
  try {
    man = JSON.parse(fs.readFileSync(manSrc, "utf8"));
  } catch (e) {
    console.error("[build-rpk-hap21] --check: cannot read manifest");
    process.exit(1);
  }
  if (record.versionName !== man.versionName || record.versionCode !== man.versionCode) {
    console.error("[build-rpk-hap21] --check: version mismatch");
    process.exit(1);
  }
  const expectedName = "com.minavigatering.probe.debug." + man.versionName + ".rpk";
  if (path.basename(record.rpkPath) !== expectedName) {
    console.error("[build-rpk-hap21] --check: rpk name mismatch");
    process.exit(1);
  }
  const bytes = fs.readFileSync(path.resolve(repoRoot, record.rpkPath));
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
    console.error("[build-rpk-hap21] --check: RPK facts differ from record");
    process.exit(1);
  }
  console.log("check-ok");
  process.exit(0);
}

// 1. require existing signing material (never generate a new key)
if (!fs.existsSync(privSrc) || !fs.existsSync(certSrc)) {
  fail("app/signing/private.pem or app/signing/certificate.pem is missing; no new key is generated and no RPK is built.", null, false);
}

// 2. validate the source manifest before calling hap
if (!fs.existsSync(manSrc)) {
  fail("band-app/src/manifest.json is missing; hap-toolkit reads it from <project>/src, so no rpk was built.", null, false);
}
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manSrc, "utf8"));
} catch (e) {
  fail("band-app/src/manifest.json is not valid JSON; no rpk was built.", null, false);
}
const manifestVersionName = manifest.versionName;
const manifestVersionCode = manifest.versionCode;
if (typeof manifestVersionName !== "string" || manifestVersionName.length === 0) {
  fail("manifest versionName is not a non-empty string; no rpk was built.", null, false);
}
if (!Number.isInteger(manifestVersionCode) || manifestVersionCode <= 0) {
  fail("manifest versionCode is not a positive integer; no rpk was built.", null, false);
}
const expectedRpkName = "com.minavigatering.probe.debug." + manifestVersionName + ".rpk";

// 3. generate the 192x192 logo next to the manifest (icon: "/logo.png")
writeLogo(logoTarget);

// 4. copy the project certs into band-app/sign/debug so hap signs with them
fs.mkdirSync(path.dirname(privDest), { recursive: true });
fs.copyFileSync(privSrc, privDest);
fs.copyFileSync(certSrc, certDest);
if (!fs.readFileSync(certDest).equals(fs.readFileSync(certSrc))) {
  fail("band-app/sign/debug/certificate.pem differs from app/signing/certificate.pem; cert parity unproven, build not continued.", null, false);
}
const usedOurKey = true;

// 5. install hap-toolkit if absent
if (!fs.existsSync(hapBin)) {
  const npmCli = findNpmCli();
  if (!npmCli) {
    fail("band-app/node_modules/hap-toolkit/bin/index.js is absent and no npm-cli.js found; no RPK built.", null, false);
  }
  const install = spawnSync(process.execPath, [npmCli, "install", "--no-audit", "--no-fund"], {
    cwd: bandApp,
    shell: false,
    encoding: "utf8",
    timeout: 240000
  });
  if (install.error || install.status !== 0) {
    fail("dependency install failed (" + (install.error ? "spawn " + install.error.code : "exit " + install.status) + "); no RPK built.", null, false);
  }
}

// 6. build with hap-toolkit 2.1.0
const build = spawnSync(process.execPath, [hapBin, "build"], {
  cwd: bandApp,
  shell: false,
  encoding: "utf8",
  timeout: 240000
});
const buildOut = (build.stdout || "") + (build.stderr || "");
const signedWithUserCert = /用户 debug 签名|user debug|sign\/debug/i.test(buildOut);
const hapExitCode = build.error ? null : build.status;

if (build.error || build.status !== 0) {
  fail(
    "no usable RPK: " +
      (build.error ? "hap spawn failed (" + build.error.code + ")" : "hap exit code " + build.status) +
      ". Last hap output: " + buildOut.trim().split("\n").slice(-30).join(" / "),
    hapExitCode,
    signedWithUserCert,
    manifestVersionName,
    manifestVersionCode
  );
}

// 7. locate exactly the expected RPK
const distDir = path.join(bandApp, "dist");
const found = fs.readdirSync(distDir).filter((f) => f === expectedRpkName);
if (found.length === 0) {
  fail("build exited 0 but no rpk named " + expectedRpkName + " in band-app/dist; no RPK claimed.", build.status, signedWithUserCert, manifestVersionName, manifestVersionCode);
}
if (found.length > 1) {
  fail("more than one rpk named " + expectedRpkName + " in band-app/dist; ambiguous, no RPK claimed.", build.status, signedWithUserCert, manifestVersionName, manifestVersionCode);
}
const rpk = path.join(distDir, found[0]);
if (!fs.existsSync(rpk)) {
  fail("selected rpk " + rpk + " no longer on disk; no RPK claimed.", build.status, signedWithUserCert, manifestVersionName, manifestVersionCode);
}
const bytes = fs.readFileSync(rpk);

// 8. inspect the artifact: manifest identity, icon, logo, and Band 10 PRO target
const AdmZip = loadAdmZip();
if (!AdmZip) {
  fail("cannot load adm-zip to inspect the RPK; no RPK claimed.", build.status, signedWithUserCert, manifestVersionName, manifestVersionCode);
}
let zip;
try {
  zip = new AdmZip(rpk);
} catch (e) {
  fail("cannot open " + rpk + " as a zip: " + e.message + "; no RPK claimed.", build.status, signedWithUserCert, manifestVersionName, manifestVersionCode);
}
const manEntry = zip.getEntry("manifest.json");
let packagedManifest;
try {
  packagedManifest = JSON.parse(manEntry.getData().toString("utf8"));
} catch (e) {
  fail("packaged manifest.json missing or invalid: " + e.message + "; no RPK claimed.", build.status, signedWithUserCert, manifestVersionName, manifestVersionCode);
}
if (packagedManifest.versionName !== manifestVersionName || packagedManifest.versionCode !== manifestVersionCode) {
  fail("packaged manifest version differs from source; no RPK claimed.", build.status, signedWithUserCert, manifestVersionName, manifestVersionCode);
}
if (packagedManifest.icon !== "/logo.png") {
  fail("packaged manifest icon is " + JSON.stringify(packagedManifest.icon) + ', expected "/logo.png"; no RPK claimed.', build.status, signedWithUserCert, manifestVersionName, manifestVersionCode);
}
if (packagedManifest.minPlatformVersion !== EXPECTED_MIN_PLATFORM) {
  fail(
    "packaged manifest minPlatformVersion is " + packagedManifest.minPlatformVersion +
      ", expected " + EXPECTED_MIN_PLATFORM + " for Band 10 PRO (Vela 5.0); no RPK claimed.",
    build.status,
    signedWithUserCert,
    manifestVersionName,
    manifestVersionCode
  );
}
const logoEntry = zip.getEntry("logo.png");
const logo = logoEntry ? logoEntry.getData() : null;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const logoWidth = logo && logo.length >= 24 && logo.slice(0, 8).equals(PNG_SIG) ? logo.readUInt32BE(16) : null;
const logoHeight = logo && logo.length >= 24 && logo.slice(0, 8).equals(PNG_SIG) ? logo.readUInt32BE(20) : null;
if (logoWidth !== 192 || logoHeight !== 192) {
  fail("packaged logo.png is " + logoWidth + "x" + logoHeight + ", expected 192x192; no RPK claimed.", build.status, signedWithUserCert, manifestVersionName, manifestVersionCode);
}
const digest = sha256(bytes);

const json = writeRecord({
  result: "success",
  argv: BUILD_ARGV,
  builder: "hap-toolkit 2.1.0",
  hapExitCode: build.status,
  rpkPath: path.relative(repoRoot, rpk),
  bytes: bytes.length,
  sha256: digest,
  versionName: manifestVersionName,
  versionCode: manifestVersionCode,
  minPlatformVersion: packagedManifest.minPlatformVersion,
  packagedIcon: packagedManifest.icon,
  logoWidth,
  logoHeight,
  usedProjectCert: signedWithUserCert,
  message: "hap-toolkit 2.1.0 build succeeded; RPK signed with app/signing sign/debug certificate for Band 10 PRO."
});
console.log(json);
console.log("[build-rpk-hap21] rpk " + rpk);
console.log("[build-rpk-hap21] bytes " + bytes.length);
console.log("[build-rpk-hap21] sha256 " + digest);
console.log("[build-rpk-hap21] signedWithUserCert " + signedWithUserCert);
