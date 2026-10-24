/* Builds artifact.html: index.html with engine.js and vision.js inlined, in the shape the Artifact tool publishes. */
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
let html = read('index.html');
const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
const body = /<body>([\s\S]*?)<script src="engine.js"><\/script>/.exec(html)[1];
const page = /<script>\n\(function \(\) \{[\s\S]*<\/script>/.exec(html.split('<script src="vision.js"></script>')[1])[0];
const themed = style
  .replace('@media (prefers-color-scheme: dark) {\n    :root {', '@media (prefers-color-scheme: dark) {\n    :root:not([data-theme="light"]) {')
  + '\n  :root[data-theme="dark"] { --bg:#12151c; --card:#1b2029; --ink:#e8ebf2; --mute:#98a1b5; --line:#2e3542; --accent:#6c93ff; --warn:#f0a35c; }'
  + '\n  body { padding-block: 0; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }'
  + '\n  header { margin: 0 calc(-1 * max(16px, env(safe-area-inset-left, 0px))); padding-left: max(16px, env(safe-area-inset-left, 0px)); }'
  + '\n  main { padding-left: 0; padding-right: 0; } input[type=text], input:not([type]) { min-width: 0; }'
  + '\n  button, input[type=file] { min-height: 40px; }';
const out = `<title>Shelf Planner</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${themed}</style>
${body}
<script>${read('engine.js')}</script>
<script>${read('vision.js')}</script>
${page}
`;
fs.writeFileSync(path.join(__dirname, 'dist-artifact.html'), out);
console.log('wrote dist-artifact.html', out.length, 'bytes');
