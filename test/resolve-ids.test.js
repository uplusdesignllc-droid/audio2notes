"use strict";
// Every static $("…") / getElementById("…") literal in renderer/app.js must
// exist as id="…" in renderer/index.html (duplicate-id bug class from deliverable 4).
// Paths resolve from THIS file, not the cwd (see check-ids).
const fs = require("fs");
const path = require("path");
const js = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

const refs = [...js.matchAll(/\$\("(?:[^"\\]|\\.)*"\)|getElementById\("(?:[^"\\]|\\.)*"\)/g)]
  .map((m) => m[0])
  .flatMap((s) => {
    const m2 = s.match(/\$\("((?:[^"\\]|\\.)*)"\)|getElementById\("((?:[^"\\]|\\.)*)"\)/);
    const id = (m2[1] !== undefined ? m2[1] : m2[2]).replace(/\\"/g, '"');
    return id;
  });
// dynamic references ($("tab-" + id) etc.) are template strings, not static literals — excluded by design
const uniq = [...new Set(refs)];
const missing = uniq.filter((id) => !ids.has(id));

console.log("static id references in app.js:", uniq.length);
console.log("missing from index.html:      ", missing.length ? missing : "none");
process.exitCode = missing.length ? 1 : 0;
