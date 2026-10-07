const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const renderMarkdown = (markdown: string): string =>
  escapeHtml(markdown)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");

const PLAYER_STYLES = `
* { box-sizing: border-box; margin: 0; }
html { height: 100%; }
body { font-family: Georgia, 'Times New Roman', serif; background: linear-gradient(160deg, #1a1a2e 0%, #23233f 100%);
  color: #f3e8c8; min-height: 100vh; min-height: 100dvh; display: flex;
  padding: calc(20px + env(safe-area-inset-top)) calc(22px + env(safe-area-inset-right))
    calc(20px + env(safe-area-inset-bottom)) calc(22px + env(safe-area-inset-left));
  font-size: clamp(15px, 4vw, 17px); line-height: 1.6; -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%; }
#motd { margin: auto; width: 100%; max-width: 30rem; max-height: 100vh; max-height: 100dvh; overflow-y: auto;
  animation: fadein 0.5s ease; }
@keyframes fadein { from { opacity: 0; transform: translateY(4px); } }
#motd h1 { font-size: 1.4rem; margin: 0 0 0.6rem; color: #e9d8a6; }
#motd h2 { font-size: 1.18rem; margin: 0.8rem 0 0.4rem; color: #e9d8a6; }
#motd h3 { font-size: 1.04rem; margin: 0.7rem 0 0.35rem; }
#motd p { margin: 0.55rem 0; }
#motd a { color: #cdb4f0; text-decoration-color: rgba(205,180,240,0.4); }
#motd p.text::first-letter { font-size: 3.1em; float: left; line-height: 0.82; padding: 0.06em 0.09em 0 0; color: #e9d8a6; }
.ref { font-size: 1.12rem; font-style: italic; letter-spacing: 0.02em; color: #e9d8a6;
  padding-bottom: 0.55rem; margin-bottom: 0.7rem; border-bottom: 1px solid rgba(233,216,166,0.25); }
.source { font-family: system-ui, sans-serif; font-size: 0.68rem; letter-spacing: 0.14em;
  text-transform: uppercase; color: #9a94b8; margin-top: 16px; }
.badge { display: inline-block; font-family: system-ui, sans-serif; font-size: 0.66rem;
  letter-spacing: 0.1em; text-transform: uppercase; color: #1a1a2e; background: #e9d8a6;
  border-radius: 4px; padding: 2px 8px; margin-bottom: 12px; }
::selection { background: #e9d8a6; color: #1a1a2e; }
`;

const PLAYER_SCRIPT = `
const el = document.getElementById("motd");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (m) => esc(m)
  .replace(/^### (.*)$/gm, "<h3>$1</h3>")
  .replace(/^## (.*)$/gm, "<h2>$1</h2>")
  .replace(/^# (.*)$/gm, "<h1>$1</h1>")
  .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
  .replace(/\\*([^*]+)\\*/g, "<em>$1</em>")
  .replace(/\\n{2,}/g, "</p><p>").replace(/\\n/g, "<br>");
function render(d) {
  let html = "";
  if (d.source === "motd") {
    html = md(d.markdown) + '<p class="source">message of the day</p>';
  } else {
    html = '<p class="ref">' + esc(d.reference) + '</p><p class="text">' + esc(d.text) + "</p>"
      + '<p class="source">' + esc(d.translation.name) + "</p>";
  }
  el.innerHTML = html;
}
async function load() {
  try {
    const res = await fetch("/api/daily");
    if (!res.ok) throw new Error(res.status);
    render(await res.json());
  } catch (e) {
    el.innerHTML = "<p>Today's message is temporarily unavailable. Please check back soon.</p>";
  }
}
load();
`;

export const playerHtml = (): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>motd-x</title>
<style>${PLAYER_STYLES}</style>
</head>
<body>
<div id="motd"><p>Loading&hellip;</p></div>
<script type="module">${PLAYER_SCRIPT}</script>
</body>
</html>`;
