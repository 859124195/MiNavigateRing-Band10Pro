"use strict";

// Startup regression test for the band probe.
//
// The failure that shipped: band-app/src/app.ux was bare JS with no <script>
// tag, so aiot-toolkit compiled app.js to a script whose body was the single
// statement "";. At runtime the host then did
// $app_exports$.default.style = $app_style$ on undefined and the app crashed
// on open. This test loads the real source, proves the script element exists,
// and actually executes onCreate / onInit in a vm so a regression fails here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const nodeVm = require("node:vm");

const srcDir = path.resolve(__dirname, "..", "src");
const parse5 = require(path.resolve(__dirname, "..", "node_modules", "aiot-parse5"));

const APP_UX = path.join(srcDir, "app.ux");
const INDEX_UX = path.join(srcDir, "pages", "index", "index.ux");
const SESSION_JS = path.join(srcDir, "common", "session.js");

function parseText(text) {
  return parse5.parseFragment(text, { scriptingEnabled: false, sourceCodeLocationInfo: true });
}

function findScriptElement(fragment) {
  let hit = null;
  const walk = (node) => {
    if (hit) {
      return;
    }
    if (node.nodeName === "script") {
      hit = node;
      return;
    }
    (node.childNodes || []).forEach(walk);
  };
  walk(fragment);
  return hit;
}

// Real loading, not a keyword grep: parse the source, require the script
// element, and run its body in a vm with a controlled require. `overrides` lets
// a caller replace individual sandbox globals (e.g. setInterval with a stub that
// only records the callback and schedules nothing).
function loadScript(sourcePath, transformImport, overrides) {
  const text = fs.readFileSync(sourcePath, "utf8");
  const element = findScriptElement(parseText(text));
  assert.ok(element, "no <script> element found in " + sourcePath);
  const body = parse5.serialize(element);

  let code = body
    .replace(/^\s*<script[^>]*>/i, "")
    .replace(/<\/script>\s*$/i, "");
  code = transformImport(code);
  assert.ok(code.indexOf("export default") === -1, "export default was not rewritten");

  const sandbox = {
    module: { exports: {} },
    require: makeRequire(path.dirname(sourcePath)),
    console,
    Date,
    Math,
    JSON,
    Set,
    Map,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    TypeError,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval
  };
  Object.assign(sandbox, overrides || {});
  sandbox.exports = sandbox.module.exports;
  const context = nodeVm.createContext(sandbox);
  new nodeVm.Script(code, { filename: sourcePath }).runInContext(context);
  return sandbox.module.exports;
}

// Timer stub for the index page: setInterval records the callback and returns an
// id without scheduling anything, so a page that arms a real 1000 ms timer can
// never keep this test alive. clearInterval removes the recorded callback.
function makeTimerStub() {
  const timers = { registered: [], nextId: 1 };
  return {
    timers,
    overrides: {
      setInterval(cb) {
        const entry = { id: timers.nextId++, cb };
        timers.registered.push(entry);
        return entry.id;
      },
      clearInterval(id) {
        const at = timers.registered.findIndex((entry) => entry.id === id);
        if (at !== -1) {
          timers.registered.splice(at, 1);
        }
      },
      setTimeout(cb) {
        const entry = { id: timers.nextId++, cb };
        timers.registered.push(entry);
        return entry.id;
      },
      clearTimeout(id) {
        const at = timers.registered.findIndex((entry) => entry.id === id);
        if (at !== -1) {
          timers.registered.splice(at, 1);
        }
      }
    }
  };
}

// A page host whose declared data keys are counting accessors: every write to a
// data field is recorded, while instance-only members (tickTimer, the GC and
// performance counters) stay plain properties and are never counted. It proves
// that a tick whose displayed content did not change performs no data write
// beyond the lifecycle counters.
const COUNTED_METHODS = [
  "onInit",
  "onReady",
  "onShow",
  "onHide",
  "onDestroy",
  "tick",
  "sharedSession",
  "applyAbnormal",
  "applyDisplay",
  "bumpLife",
  "armTickTimer",
  "clearTickTimer",
  "toggleDebug",
  "ensurePerfState",
  "gcDue",
  "callGC",
  "maybeRunGC",
  "updatePerfText",
  "finishTickPerf"
];

function makeCountingHost(def) {
  const counts = {};
  const values = {};
  const host = {};
  Object.keys(def.data).forEach((key) => {
    values[key] = def.data[key];
    counts[key] = 0;
    Object.defineProperty(host, key, {
      get() {
        return values[key];
      },
      set(newVal) {
        counts[key] += 1;
        values[key] = newVal;
      },
      configurable: true,
      enumerable: true
    });
  });
  COUNTED_METHODS.forEach((name) => {
    host[name] = def[name].bind(host);
  });
  return { host, counts, values };
}

function makeRequire(baseDir) {
  return function (id) {
    if (id === "@system.interconnect" || id === "@system.vibrator") {
      throw new Error("host unavailable");
    }
    if (id.startsWith(".")) {
      return require(path.resolve(baseDir, id));
    }
    return require(id);
  };
}

test("app.ux has a script element whose body runs onCreate inside a try", () => {
  const text = fs.readFileSync(APP_UX, "utf8");
  const element = findScriptElement(parseText(text));
  assert.ok(element, "app.ux must contain a <script> element, otherwise app.js is empty");
  const body = parse5.serialize(element);
  assert.ok(body.includes("onCreate"), "script body must define onCreate");
  const tryAt = body.indexOf("try");
  const interconnectAt = body.indexOf('require("@system.interconnect")');
  assert.ok(tryAt !== -1, "script body must wrap host access in try");
  assert.ok(
    interconnectAt !== -1 && tryAt < interconnectAt,
    'require("@system.interconnect") must appear inside the try block'
  );
});

test("app.ux onCreate survives an unavailable host", () => {
  const def = loadScript(APP_UX, (code) =>
    code.replace(
      'import session from "./common/session.js";',
      'const session = require("./common/session.js");'
    ).replace("export default", "module.exports =")
  );
  assert.strictEqual(typeof def.onCreate, "function");
  assert.doesNotThrow(() => def.onCreate());
});

test("app.ux onCreate wires a working host and renders a left turn", () => {
  const session = require(SESSION_JS);
  session.resetForTest();

  let connect = null;
  const fakeInterconnect = {
    instance() {
      connect = {
        onmessage: null,
        onopen: null,
        onclose: null,
        onerror: null,
        send() {},
        getReadyState(options) {
          options.success({ status: 2 });
        },
        diagnosis(options) {
          options.success({ status: 1001 });
        }
      };
      return connect;
    }
  };
  const fakeVibrator = {
    vibrate() {
      throw new Error("vibrate unavailable");
    }
  };

  const text = fs.readFileSync(APP_UX, "utf8");
  const element = findScriptElement(parseText(text));
  const body = parse5.serialize(element);
  const code = body
    .replace('import session from "./common/session.js";', 'const session = require("./common/session.js");')
    .replace("export default", "module.exports =");
  const sandbox = {
    module: { exports: {} },
    require(id) {
      if (id === "@system.interconnect") {
        return fakeInterconnect;
      }
      if (id === "@system.vibrator") {
        return fakeVibrator;
      }
      if (id.startsWith(".")) {
        return require(path.resolve(srcDir, id));
      }
      return require(id);
    },
    console,
    Date,
    Math,
    JSON,
    Set,
    Map,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    TypeError,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval
  };
  sandbox.exports = sandbox.module.exports;
  new nodeVm.Script(code, { filename: APP_UX }).runInContext(nodeVm.createContext(sandbox));

  const def = sandbox.module.exports;
  assert.doesNotThrow(() => def.onCreate());
  assert.ok(connect && typeof connect.onmessage === "function", "onmessage must be registered");

  // The fake host reports ready state 2 (disconnected) and diagnosis status
  // 1001 (peer app not installed). Both must land in session.current().
  assert.strictEqual(session.current().diagReady, "2已断开");
  assert.strictEqual(session.current().diagStatus, "1001对端未安装");

  const message = {
    data: {
      v: 1,
      kind: "state",
      id: "probe-1",
      navStatus: "active",
      action: "left",
      actionId: "t-startup",
      distanceM: 300,
      roadName: "中山路",
      sentAtMs: 1
    }
  };
  assert.doesNotThrow(() => connect.onmessage(message));
  assert.strictEqual(session.current().title, "左转");
  // The real frame is summarised, never stored whole: only type and id. Note
  // that in this sandbox `session` is the real module's export, so the string
  // arrives across the realm boundary and its prototype is not this file's
  // String.prototype: that is exactly the host's official String data.data
  // case, and the summary must still be the object type plus its id.
  assert.strictEqual(session.current().inboundSummary, "object id=probe-1");
});

// AC4: the 14 direction icons the page renders through
// /common/images/<action>.png must already be at the .nav-icon native size
// (245x245 on Band 10 PRO). With designWidth=192 and the .nav-icon element
// declared at 140px, the band renders it at 140 * 336/192 = 245 physical px,
// so 245x245 is the native bitmap that avoids runtime upscaling (which would
// drop the anti-aliased alpha the icons rely on).
test("every ACTION_LABELS icon is a native 245x245 8-bit RGBA PNG", () => {
  const codec = require(path.join(srcDir, "common", "codec.js"));
  const ids = Object.keys(codec.ACTION_LABELS);
  assert.strictEqual(ids.length, 14, "ACTION_LABELS must expose 14 actions");
  for (const id of ids) {
    const file = path.join(srcDir, "common", "images", id + ".png");
    assert.ok(fs.existsSync(file), "missing icon /common/images/" + id + ".png");
    const buf = fs.readFileSync(file);
    assert.ok(buf.length > 33, id + ".png is too short to hold an IHDR chunk");
    assert.strictEqual(buf.toString("latin1", 12, 16), "IHDR", id + ".png: first chunk must be IHDR");
    assert.strictEqual(buf.readUInt32BE(16), 245, id + ".png width must be 245");
    assert.strictEqual(buf.readUInt32BE(20), 245, id + ".png height must be 245");
    assert.strictEqual(buf[24], 8, id + ".png bit depth must be 8");
    assert.strictEqual(buf[25], 6, id + ".png color type must be 6 (RGBA)");
  }
});

test("index.ux onInit renders the connecting state", () => {
  const session = require(SESSION_JS);
  session.resetForTest();

  // onInit now arms a real 1000 ms interval, so the vm sandbox must never use
  // the real setInterval: the stub only records the callback.
  const stub = makeTimerStub();
  const def = loadScript(
    INDEX_UX,
    (code) => code.replace("export default", "module.exports ="),
    stub.overrides
  );

  // Official rule (https://iot.mi.com/vela/quickapp/zh/guide/framework/script/page-data.html):
  // `data` is an Object, not a function. The host copies that object into
  // $data; a function-shaped data would initialise nothing (the shipped vc5
  // defect: init=NaN, ready/show/tick=undefined). No call is made here.
  assert.strictEqual(typeof def.data, "object",
    "index.ux data must be an Object, got " + typeof def.data);
  assert.ok(def.data !== null && !Array.isArray(def.data), "index.ux data must be a plain object");
  const pageVm = Object.assign({}, def.data);
  [
    "onInit",
    "onReady",
    "onShow",
    "tick",
    "sharedSession",
    "applyAbnormal",
    "applyDisplay",
    "bumpLife",
    "armTickTimer",
    "clearTickTimer",
    // onInit now seeds the GC/performance state and tick closes its timing and
    // the paced GC attempt, so the new methods must be bound here as well. The
    // assertions below are unchanged.
    "ensurePerfState",
    "gcDue",
    "callGC",
    "maybeRunGC",
    "updatePerfText",
    "finishTickPerf"
  ].forEach((name) => {
    pageVm[name] = def[name].bind(pageVm);
  });
  // The page no longer imports session: it reads the one instance the app
  // published on its export through the official this.$app.$def binding.
  pageVm.$app = { $def: { navInit: "ok", navSession: session } };
  assert.doesNotThrow(() => pageVm.onInit());
  assert.strictEqual(pageVm.title, "连接中");
  // The four diagnosis lines are visible with their initial values.
  assert.strictEqual(pageVm.diagReady, "未探测");
  assert.strictEqual(pageVm.diagStatus, "未探测");
  assert.strictEqual(pageVm.inboundSummary, "0帧");
  assert.strictEqual(pageVm.linkEvent, "无");
  // onInit alone counts itself and arms exactly one timer; the synchronous tick
  // it performs is not the interval callback and must not be counted.
  assert.strictEqual(pageVm.lifeText, "init=1 ready=0 show=0 tick=0");
  assert.strictEqual(stub.timers.registered.length, 1);

  // The registered callback is the refresh path: it counts one tick and the
  // page still has no frame, so it stays in the connecting state.
  stub.timers.registered[0].cb();
  assert.strictEqual(pageVm.lifeText, "init=1 ready=0 show=0 tick=1");
  assert.strictEqual(pageVm.title, "连接中");
  assert.strictEqual(stub.timers.registered.length, 1);

  // Leave no live timer behind for the rest of the run.
  pageVm.clearTickTimer();
  assert.strictEqual(stub.timers.registered.length, 0);
});

// AC1: applyDisplay / applyAbnormal write a page data field only when the new
// value differs from the current one. The host below is assembled with a
// counting setter per declared data key, so the exact number of data writes per
// tick is observable. A real session drives the display and only the plugin
// timer stub is used, so no live 1000 ms timer can keep the test alive.
test("index.ux ticks a settled display without rewriting unchanged data", () => {
  const session = require(SESSION_JS);
  session.resetForTest();

  const stub = makeTimerStub();
  const def = loadScript(
    INDEX_UX,
    (code) => code.replace("export default", "module.exports ="),
    stub.overrides
  );

  const { host, counts } = makeCountingHost(def);
  host.$app = { $def: { navInit: "ok", navSession: session } };

  // The real clock is used for the page, so the frame must be stamped with the
  // real now: otherwise the session's 15 s liveness would degrade the display
  // to 连接中 and the settled state below would not exist.
  const frameAtMs = Date.now();

  // One real frame, then a settled display: the same left turn at 300 m with the
  // same diagnostics. The first frames legitimately rewrite fields; the interest
  // is in the two identical ticks that follow.
  const message = (overrides) =>
    Object.assign(
      {
        v: 1,
        kind: "state",
        id: "settled",
        navStatus: "active",
        action: "left",
        actionId: "ui-settled",
        distanceM: 300,
        roadName: "中山路",
        link: "connected",
        sentAtMs: 1
      },
      overrides
    );
  session.onMessage(message({}), frameAtMs);
  session.tick(frameAtMs);

  assert.doesNotThrow(() => host.onInit());
  assert.strictEqual(stub.timers.registered.length, 1, "onInit must arm exactly one timer");
  assert.strictEqual(host.title, "左转");
  assert.strictEqual(host.iconSrc, "/common/images/left.png");
  assert.strictEqual(host.hasDistance, true);
  assert.strictEqual(host.distanceText, "300米");
  assert.strictEqual(host.distanceShortVisible, true);
  assert.strictEqual(host.distanceLongVisible, false);

  // The synchronous onInit tick does not count as an interval tick, exactly as
  // before. It is allowed to rewrite the freshly created page.
  const baseline = Object.keys(def.data).reduce((acc, key) => {
    acc[key] = counts[key];
    return acc;
  }, {});

  // First interval tick: nothing changed, only the two lifecycle fields move.
  stub.timers.registered[0].cb();
  assert.strictEqual(host.lifeText, "init=1 ready=0 show=0 tick=1");
  assert.strictEqual(host.lifeTick - baseline.lifeTick, 1);
  assert.strictEqual(host.lifeText !== undefined, true);
  assert.strictEqual(counts.lifeTick - baseline.lifeTick, 1);
  assert.strictEqual(counts.lifeText - baseline.lifeText, 1);
  assert.strictEqual(host.perfReady, true, "the first tick seeds the perf state");
  assert.strictEqual(host.debugVisible, false);
  assert.strictEqual(host.perfText, "", "collapsed diagnostics must not write perfText");
  assert.strictEqual(counts.perfText, 0);

  // Second interval tick, still nothing changed: exactly the same single write
  // to each lifecycle field and no other data write at all.
  stub.timers.registered[0].cb();
  assert.strictEqual(host.lifeText, "init=1 ready=0 show=0 tick=2");
  assert.strictEqual(counts.lifeTick - baseline.lifeTick, 2);
  assert.strictEqual(counts.lifeText - baseline.lifeText, 2);

  Object.keys(def.data).forEach((key) => {
    if (key === "lifeTick" || key === "lifeText") {
      return;
    }
    assert.strictEqual(
      counts[key] - baseline[key],
      0,
      key + " was rewritten by a settled tick (" + counts[key] + " writes)"
    );
  });

  // A repeated abnormal tick writes nothing either: the second applyAbnormal
  // finds every field already at its abnormal value.
  const broken = makeCountingHost(def);
  broken.host.$app = { $def: null };
  broken.host.ensurePerfState();
  broken.host.applyAbnormal();
  const abnormalFirst = Object.assign({}, broken.counts);
  broken.host.applyAbnormal();
  Object.keys(def.data).forEach((key) => {
    assert.strictEqual(
      broken.counts[key] - abnormalFirst[key],
      0,
      "applyAbnormal rewrote " + key + " on a repeated tick"
    );
  });
  assert.strictEqual(broken.host.title, "异常初始化");

  // Distance projection: 0 is a real value (still a distance, still short) and a
  // non-numeric / missing distance clears text and both tiers, exactly as the
  // original branch did.
  host.applyDisplay({ title: "左转", distanceM: 0, roadName: "中山路" });
  assert.strictEqual(host.hasDistance, true);
  assert.strictEqual(host.distanceText, "0米");
  assert.strictEqual(host.distanceShortVisible, true);
  assert.strictEqual(host.distanceLongVisible, false);

  host.applyDisplay({ title: "左转", distanceM: "300", roadName: "中山路" });
  assert.strictEqual(host.hasDistance, false, "a string distance is not a number");
  assert.strictEqual(host.distanceText, "");
  assert.strictEqual(host.distanceShortVisible, false);
  assert.strictEqual(host.distanceLongVisible, false);

  host.clearTickTimer();
  assert.strictEqual(stub.timers.registered.length, 0);
});

// AC3: the paced best-effort GC and the performance line. A fake clock and a
// fake global.runGC make the pacing, the safety and the numbers observable; the
// same real UX VM is used, so the counters must never leak into `data`.
test("index.ux paces runGC and only renders the perf line when expanded", () => {
  const session = require(SESSION_JS);
  session.resetForTest();

  const stub = makeTimerStub();
  let nowMs = 1000000;
  const gcCalls = [];
  const fakeGlobal = {
    runGC() {
      gcCalls.push(nowMs);
    }
  };
  const def = loadScript(
    INDEX_UX,
    (code) => code.replace("export default", "module.exports ="),
    Object.assign({}, stub.overrides, {
      Date: { now: () => nowMs },
      global: fakeGlobal
    })
  );

  const { host, counts, values } = makeCountingHost(def);
  host.$app = { $def: { navInit: "ok", navSession: session } };

  assert.doesNotThrow(() => host.onInit());
  assert.strictEqual(gcCalls.length, 0, "no GC during the first 30 s");
  assert.strictEqual(host.gcCallCount, 0);

  // 29 s: still inside the guard window, a tick must not call runGC.
  nowMs = 1000000 + 29000;
  stub.timers.registered[0].cb();
  assert.strictEqual(gcCalls.length, 0, "no GC just before the 30 s guard");
  assert.strictEqual(host.gcCallCount, 0);

  // 30 s: the first allowed attempt fires exactly once.
  nowMs = 1000000 + 30000;
  stub.timers.registered[0].cb();
  assert.strictEqual(gcCalls.length, 1, "the first GC attempt happens at 30 s");
  assert.strictEqual(host.gcCallCount, 1);
  assert.strictEqual(host.gcLastAttemptMs, 1000000 + 30000);

  // Under 60 s since the attempt: no second call even though the tick runs.
  nowMs = 1000000 + 89000;
  stub.timers.registered[0].cb();
  assert.strictEqual(gcCalls.length, 1, "GC must not be retried per second");
  assert.strictEqual(host.gcCallCount, 1);

  // A full minute later: the limiter allows the next attempt.
  nowMs = 1000000 + 90000;
  stub.timers.registered[0].cb();
  assert.strictEqual(gcCalls.length, 2, "the 60 s limiter allows the next attempt");
  assert.strictEqual(host.gcCallCount, 2);

  // onHide releases once more, independently of the tick limiter, and clears
  // the refresh timer.
  nowMs = 1000000 + 91000;
  host.onHide();
  assert.strictEqual(gcCalls.length, 3, "onHide performs its own GC");
  assert.strictEqual(stub.timers.registered.length, 0, "onHide clears the timer");
  host.onDestroy();
  assert.strictEqual(stub.timers.registered.length, 0, "onDestroy keeps the timer cleared");

  // The counters are plain instance properties: none of them is a data field,
  // so nothing above was ever rendered or counted as a data write.
  ["gcCallCount", "gcLastMs", "perfMaxTickMs", "perfBucket", "perfInitAtMs", "gcLastAttemptMs", "perfReady"].forEach(
    (key) => {
      assert.ok(!(key in def.data), key + " must not be declared in data");
      assert.ok(!(key in counts), key + " must not be a counted data key");
    }
  );

  // Collapsed diagnostics never write perfText, even after a GC and a tick.
  host.clearTickTimer();
  const collapsedWrites = counts.perfText;
  nowMs = 1000000 + 92000;
  host.onInit();
  assert.strictEqual(counts.perfText, collapsedWrites, "a collapsed tick must not write perfText");
  assert.strictEqual(values.perfText, "");

  // Expanded diagnostics: the single performance line carries all four numbers
  // and is written exactly when it changes.
  nowMs = 1000000 + 93000;
  host.toggleDebug();
  assert.strictEqual(host.debugVisible, true);
  const before = counts.perfText;
  nowMs = 1000000 + 94000;
  stub.timers.registered[0].cb();
  assert.strictEqual(counts.perfText, before + 1, "the expanded tick writes perfText once");
  assert.match(values.perfText, /^最长\d+ms 入帧\d+帧 GC\d+次 \d+ms$/);
  assert.ok(values.perfText.includes("GC3次"), "the line reports three GC calls: " + values.perfText);

  // A second expanded tick with identical numbers performs no write: the line
  // is deduplicated like every other data field.
  const stableWrites = counts.perfText;
  const stableText = values.perfText;
  nowMs = 1000000 + 95000;
  stub.timers.registered[0].cb();
  assert.strictEqual(counts.perfText, stableWrites, "an unchanged perf line must not be rewritten");
  assert.strictEqual(values.perfText, stableText);

  // The inbound count comes from the session; a missing session reports 0
  // instead of touching null.
  const noSession = makeCountingHost(def);
  noSession.host.$app = { $def: null };
  noSession.host.ensurePerfState();
  noSession.host.debugVisible = true;
  assert.doesNotThrow(() => noSession.host.updatePerfText(null, nowMs));
  assert.ok(noSession.values.perfText.includes("入帧0帧"), noSession.values.perfText);

  // A throwing runGC is swallowed and still counts as one real attempt.
  const throwing = loadScript(
    INDEX_UX,
    (code) => code.replace("export default", "module.exports ="),
    Object.assign({}, stub.overrides, {
      Date: { now: () => nowMs },
      global: {
        runGC() {
          throw new Error("runGC unavailable");
        }
      }
    })
  );
  const throwingHost = makeCountingHost(throwing);
  throwingHost.host.$app = { $def: { navInit: "ok", navSession: session } };
  assert.doesNotThrow(() => throwingHost.host.onInit());
  nowMs = throwingHost.host.perfInitAtMs + 30000;
  assert.doesNotThrow(() => throwingHost.host.tick());
  assert.strictEqual(throwingHost.host.gcCallCount, 1, "a throwing runGC is still one attempt");
  assert.ok(throwingHost.host.gcLastMs >= 0, "the cost stays a non-negative millisecond value");
  assert.strictEqual(throwingHost.host.debugVisible, false);
  assert.strictEqual(throwingHost.counts.perfText, 0, "a collapsed page writes no perf line");

  // No global at all: the display and the lifecycle continue, nothing throws.
  const noGlobal = loadScript(
    INDEX_UX,
    (code) => code.replace("export default", "module.exports ="),
    Object.assign({}, stub.overrides, { Date: { now: () => nowMs } })
  );
  const noGlobalHost = makeCountingHost(noGlobal);
  noGlobalHost.host.$app = { $def: { navInit: "ok", navSession: session } };
  assert.doesNotThrow(() => noGlobalHost.host.onInit());
  nowMs = noGlobalHost.host.perfInitAtMs + 40000;
  session.onMessage(
    {
      v: 1,
      kind: "state",
      id: "no-global",
      navStatus: "active",
      action: "left",
      actionId: "ui-no-global",
      distanceM: 300,
      roadName: "中山路",
      link: "connected",
      sentAtMs: nowMs
    },
    nowMs
  );
  assert.doesNotThrow(() => noGlobalHost.host.tick());
  assert.strictEqual(noGlobalHost.host.gcCallCount, 0, "no global means no runGC call");
  assert.strictEqual(noGlobalHost.host.title, "左转", "the display is untouched");
  assert.ok(noGlobalHost.host.lifeText.indexOf("init=1") === 0, noGlobalHost.host.lifeText);

  // Minute bucket: the longest tick is reset when the 60 s window rolls over.
  const bucketHost = makeCountingHost(throwing);
  bucketHost.host.$app = { $def: { navInit: "ok", navSession: session } };
  bucketHost.host.ensurePerfState();
  const initAt = bucketHost.host.perfInitAtMs;
  nowMs = initAt + 1000;
  bucketHost.host.finishTickPerf(initAt, null);
  assert.strictEqual(bucketHost.host.perfMaxTickMs, 1000, "the longest tick is recorded in whole milliseconds");
  nowMs = initAt + 61000;
  bucketHost.host.finishTickPerf(initAt + 61000, null);
  assert.strictEqual(bucketHost.host.perfMaxTickMs, 0, "a new minute bucket resets the longest tick");
});
