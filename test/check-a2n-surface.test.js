"use strict";
// Renderer/preload surface check: every window.a2n.X the renderer calls must be
// exposed by preload. Paths resolve from THIS file, not the cwd (see check-ids).
const fs = require("fs");
const path = require("path");
const pre = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
// names exposed on window.a2n by preload's contextBridge map
const exposed = new Set();
const block = pre.slice(pre.indexOf("exposeInMainWorld"));
for (const m of block.matchAll(/^\s{2}([A-Za-z0-9_]+)\s*:/gm)) exposed.add(m[1]);
// names the renderer actually calls
const used = new Set();
for (const m of app.matchAll(/window\.a2n\.([A-Za-z0-9_]+)/g)) used.add(m[1]);
const missing = [...used].filter((n) => !exposed.has(n)).sort();
console.log("preload exposes :", exposed.size);
console.log("renderer uses   :", used.size);
console.log("MISSING (renderer calls, preload does not expose):", missing.length ? missing.join(", ") : "none");
const p6 = ["participantsAnswer","participantsEdit","participantsStatus","onParticipants","stopRecord"];
console.log("P6 names exposed:", p6.filter((n)=>exposed.has(n)).join(", "));
console.log("P6 names used   :", p6.filter((n)=>used.has(n)).join(", "));
process.exit(missing.length ? 1 : 0);
