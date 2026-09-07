import { test } from "node:test";
import assert from "node:assert/strict";
import { launchd } from "../src/launchd.js";

test("LaunchAgent binds an absolute writer and explicit policy without a shell", () => {
  const plist = launchd(
    "/source & <history>",
    "/private/index.sqlite",
    "/private/policy.json",
  );
  assert.match(plist, /<string>watch<\/string>/);
  assert.match(
    plist,
    /<string>--policy<\/string><string>\/private\/policy.json/,
  );
  assert.match(plist, /source &amp; &lt;history&gt;/);
  assert.doesNotMatch(plist, /<string>sh<|--all|serve/);
  assert.throws(() => launchd("relative", "/db", "/policy"), /absolute/);
  assert.throws(
    () => launchd("/bad\0path", "/db", "/policy"),
    /unsupported by XML/,
  );
});
