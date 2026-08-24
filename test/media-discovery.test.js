const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fail = 0;
const check = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    fail += 1;
  }
};

const context = { URL };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "media-discovery.js"), "utf8"),
  context,
  { filename: "media-discovery.js" }
);

const api = context.KoeMediaDiscovery;
const master = "https://media.example/title/master.m3u8?token=secret&expires=999";
const escaped = "https:\\/\\/media.example\\/title\\/240\\/index.m3u8?token=secret\\u0026expires=999";
const definitions = api.extractHlsDefinitions(`
  player.setVideoHLS('${master}');
  player.config = { hls: "${escaped}" };
  player.setVideoUrlHigh('https://media.example/title/high.mp4?token=secret');
  player.setVideoHLS('${master}');
`);

check(definitions.length === 2, "inline discovery extracts HLS only and removes duplicates");
check(definitions[0]?.url === master, "plain signed HLS URL is preserved in memory");
check(definitions[1]?.url.includes("/240/index.m3u8") && definitions[1]?.url.includes("&expires=999"),
  "escaped slash and unicode query separators are decoded");
check(definitions[1]?.quality === 240, "quality is inferred for candidate ranking");

const fakeDocument = {
  querySelectorAll: () => [
    { textContent: `const oldPlayer = '${master}';` },
    { textContent: `const currentPlayer = '${escaped}';` }
  ]
};
const collected = api.collectInlineHlsDefinitions(fakeDocument);
check(collected.length === 2, "document collector scans inline player definitions");

console.log(fail === 0 ? "media discovery regression PASS" : `${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
