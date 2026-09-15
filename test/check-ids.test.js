"use strict";
// Duplicate-id check over renderer/index.html.
// Paths are resolved from THIS file, not the cwd: the suite used to rely on being
// run from the repo root, which stops being true now that it lives in test/.
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
const count = (x) => ids.filter((v) => v === x).length;

console.log("distinct ids:", new Set(ids).size, "| total id attrs:", ids.length);
console.log("duplicates:  ", dup.length ? [...new Set(dup)] : "none");
console.log('speaker-rows        :', count("speaker-rows"), "occurrence(s)");
console.log('speaker-model-rows  :', count("speaker-model-rows"), "occurrence(s)");

const fail = dup.length > 0 || count("speaker-rows") !== 1 || count("speaker-model-rows") !== 1;
console.log(fail ? "FAIL" : "OK: unique ids; speaker-rows and speaker-model-rows each exactly once");
process.exitCode = fail ? 1 : 0;
