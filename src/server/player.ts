const PLAYER_STYLES = `
* { box-sizing: border-box; margin: 0; }
html { height: 100%; }
body { font-family: Georgia, 'Times New Roman', serif; background: linear-gradient(160deg, #1a1a2e 0%, #23233f 100%);
  color: #f3e8c8; min-height: 100vh; min-height: 100dvh; display: flex;
  padding: calc(20px + env(safe-area-inset-top)) calc(22px + env(safe-area-inset-right))
    calc(20px + env(safe-area-inset-bottom)) calc(22px + env(safe-area-inset-left));
  font-size: clamp(15px, 4vw, 17px); line-height: 1.6; -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%; }
#wrap { margin: auto; width: 100%; max-width: 30rem; max-height: 100vh; max-height: 100dvh; overflow-y: auto;
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
#signin { font-family: system-ui, sans-serif; text-align: center; margin-top: 22px;
  padding-top: 14px; border-top: 1px solid rgba(233,216,166,0.15); }
#signin button { font-family: system-ui, sans-serif; font-size: 0.82rem; font-weight: 600;
  color: #1a1a2e; background: #e9d8a6; border: 0; border-radius: 999px; padding: 9px 20px;
  cursor: pointer; }
#signin button:disabled { opacity: 0.6; cursor: default; }
#signin .hint { font-size: 0.72rem; color: #9a94b8; margin-top: 8px; }
#signin a { color: #e9d8a6; font-size: 0.78rem; }
::selection { background: #e9d8a6; color: #1a1a2e; }
`;

const PLAYER_SCRIPT = `
var el = document.getElementById("motd");
var authBox = document.getElementById("signin");
var authLink = document.getElementById("auth-link");
var btn = document.getElementById("signin-btn");
var token = null;
var mem = {};

var storage = {
  get: function (k) {
    try { return window.sessionStorage.getItem(k); } catch (e) {
      return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
    }
  },
  set: function (k, v) {
    try { window.sessionStorage.setItem(k, v); } catch (e) { mem[k] = v; }
  },
  del: function (k) {
    try { window.sessionStorage.removeItem(k); } catch (e) { delete mem[k]; }
  },
};

var esc = function (s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
};
var md = function (m) {
  return esc(m)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\\*([^*]+)\\*/g, "<em>$1</em>")
    .replace(/\\n{2,}/g, "</p><p>").replace(/\\n/g, "<br>");
};

var render = function (d, audience) {
  var html = "";
  if (audience === "friend") html += '<span class="badge">✦ friend</span>';
  if (d.source === "motd") {
    html += md(d.markdown) + '<p class="source">message of the day</p>';
  } else {
    html += '<p class="ref">' + esc(d.reference) + '</p><p class="text">' + esc(d.text) + "</p>"
      + '<p class="source">' + esc(d.translation.name) + "</p>";
  }
  el.innerHTML = html;
};

var refreshMe = function () {
  if (!token) return Promise.resolve(null);
  return fetch("/api/daily/me", { headers: { Authorization: "Bearer " + token } })
    .then(function (res) {
      if (res.status === 401) { token = null; storage.del("motd_session"); return null; }
      if (!res.ok) return null;
      return res.json();
    })
    .catch(function () { return null; });
};

var setAuthVisible = function (visible) {
  authBox.style.display = visible ? "" : "none";
};

var load = function () {
  el.innerHTML = "<p>Loading&hellip;</p>";
  refreshMe().then(function (me) {
    if (me !== null) {
      render(me, me.audience);
      setAuthVisible(false);
      return;
    }
    setAuthVisible(!token);
    fetch("/api/daily")
      .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then(function (d) { render(d, "public"); })
      .catch(function () {
        el.innerHTML = "<p>Today's message is temporarily unavailable. Please check back soon.</p>";
      });
  });
};

var poll = function (pollToken) {
  var attempts = 0;
  var timer = setInterval(function () {
    attempts += 1;
    if (attempts > 300) { clearInterval(timer); btn.disabled = false; return; }
    fetch("/auth/poll?token=" + encodeURIComponent(pollToken))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.status === "completed") {
          clearInterval(timer);
          if (data.session_token) {
            token = data.session_token;
            storage.set("motd_session", token);
          }
          load();
        } else if (data.status === "expired") {
          clearInterval(timer);
          btn.disabled = false;
        }
      })
      .catch(function () {});
  }, 2000);
};

var signIn = function () {
  btn.disabled = true;
  btn.textContent = "Signing in…";
  var inIframe = window.self !== window.top;
  var context = inIframe ? "iframe" : "standalone";
  fetch("/auth/start?context=" + context)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (context === "iframe") {
        var win = window.open(data.authorize_url, "_blank");
        if (!win && authLink) {
          authLink.innerHTML = "";
          var a = document.createElement("a");
          a.href = data.authorize_url;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = "Pop-up blocked — open sign-in";
          authLink.appendChild(a);
        }
        poll(data.poll_token);
      } else {
        window.location.assign(data.authorize_url);
      }
    })
    .catch(function () {
      btn.disabled = false;
      btn.textContent = "Sign in with X";
    });
};

btn.addEventListener("click", signIn);
token = storage.get("motd_session");
load();
`;

const PLAYER_BODY = `
<div id="wrap">
  <div id="motd"><p>Loading&hellip;</p></div>
  <div id="signin">
    <button id="signin-btn" type="button">Sign in with X</button>
    <p class="hint">Sign in to see personalized messages</p>
    <p id="auth-link"></p>
  </div>
</div>`;

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
${PLAYER_BODY}
<script type="module">${PLAYER_SCRIPT}</script>
</body>
</html>`;
