const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
async function api(path, options) {
  const r = await fetch(path, options);
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "エラー");
  return data;
}
function bufferToBase64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}
function base64urlToBuffer(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer;
}
function registrationOptions(options) {
  options.challenge = base64urlToBuffer(options.challenge);
  options.user.id = base64urlToBuffer(options.user.id);
  for (const credential of options.excludeCredentials || []) {
    credential.id = base64urlToBuffer(credential.id);
  }
  return options;
}
function authenticationOptions(options) {
  options.challenge = base64urlToBuffer(options.challenge);
  for (const credential of options.allowCredentials || []) {
    credential.id = base64urlToBuffer(credential.id);
  }
  return options;
}
function serializeCredential(credential) {
  const response = credential.response;
  const result = {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: { clientDataJSON: bufferToBase64url(response.clientDataJSON) },
  };
  if ("attestationObject" in response) {
    result.response.attestationObject = bufferToBase64url(response.attestationObject);
  } else {
    result.response.authenticatorData = bufferToBase64url(response.authenticatorData);
    result.response.signature = bufferToBase64url(response.signature);
    if (response.userHandle) result.response.userHandle = bufferToBase64url(response.userHandle);
  }
  return result;
}
async function passkeyRegister() {
  const status = $("#passkeyStatus");
  status.textContent = "登録の準備中…";
  try {
    const begin = await api("/api/passkey/register/options", { method: "POST" });
    const credential = await navigator.credentials.create({
      publicKey: registrationOptions(begin.options),
    });
    if (!credential) throw Error("パスキー登録がキャンセルされました");
    const result = await api("/api/passkey/register/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: begin.challengeId,
        termsAccepted: true,
        response: serializeCredential(credential),
      }),
    });
    alert("登録しました。あなたのIDは " + result.userId + " です。");
    await refresh();
  } catch (error) {
    status.textContent = error.message;
    alert(error.message);
  }
}
async function passkeyLogin(rethrow = false) {
  const status = $("#passkeyStatus");
  status.textContent = "認証中…";
  try {
    const begin = await api("/api/passkey/login/options", { method: "POST" });
    const credential = await navigator.credentials.get({
      publicKey: authenticationOptions(begin.options),
    });
    if (!credential) throw Error("パスキー認証がキャンセルされました");
    await api("/api/passkey/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: begin.challengeId,
        response: serializeCredential(credential),
      }),
    });
    await refresh();
  } catch (error) {
    status.textContent = error.message;
    if (rethrow) throw error;
    alert(error.message);
  }
}
function showTerms() {
  return new Promise((resolve) => {
    const dialog = $("#termsDialog");
    const form = $("#termsForm");
    const agree = $("#termsAgree");
    const submit = $("#termsSubmit");
    agree.checked = false;
    submit.disabled = true;
    agree.onchange = () => {
      submit.disabled = !agree.checked;
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      dialog.close(agree.checked ? "agree" : "cancel");
    };
    dialog.onclose = () => resolve(dialog.returnValue === "agree");
    dialog.showModal();
  });
}
async function addPasskey() {
  const begin = await api("/api/passkey/add/options", { method: "POST" });
  const credential = await navigator.credentials.create({
    publicKey: registrationOptions(begin.options),
  });
  if (!credential) throw Error("パスキー追加がキャンセルされました");
  await api("/api/passkey/add/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: begin.challengeId,
      response: serializeCredential(credential),
    }),
  });
}
async function loadPasskeys() {
  const passkeys = await api("/api/passkeys");
  $("#passkeyList").innerHTML = passkeys.map((passkey, index) =>
    `<div class="passkey-item"><span>パスキー${index + 1}<small>${
      new Date(passkey.created_at).toLocaleString("ja-JP")
    }</small></span><button type="button" class="small danger" data-passkey-id="${
      esc(passkey.id)
    }">削除</button></div>`
  ).join("");
  $("#passkeyList").querySelectorAll("[data-passkey-id]").forEach((button) => {
    button.onclick = async () => {
      if (!confirm("このパスキーを削除しますか？")) return;
      try {
        await api(`/api/passkeys/${encodeURIComponent(button.dataset.passkeyId)}`, {
          method: "DELETE",
        });
        await loadPasskeys();
      } catch (error) {
        alert(error.message);
      }
    };
  });
}
function render(r, transcript) {
  $("#result").className = "result";
  $("#result").innerHTML = `<h3>要点</h3><p>${esc(r.summary)}</p><h3>決定事項</h3><ul>${
    (r.decisions || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>なし</li>"
  }</ul><h3>次のアクション</h3><ul>${
    (r.actions || []).map((x) => `<li>${esc(x.task)} — ${esc(x.owner)} / ${esc(x.due)}</li>`).join(
      "",
    ) || "<li>なし</li>"
  }</ul><h3>ヌケモレ・要確認</h3><ul>${
    (r.gaps || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>特になし</li>"
  }</ul><h3>議論を深めた方がよい事項</h3><ol>${
    (r.deepening || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>未分析</li>"
  }</ol><h3>推定話者</h3><p>${
    (r.speakers || []).map(esc).join("、") || "不明"
  }</p><details><summary>文字起こし</summary><pre>${esc(transcript)}</pre></details>`;
}
async function loadUsers() {
  const us = await api("/api/admin/users");
  $("#users").innerHTML = us.map((u) =>
    `<div class="user"><span><b>${esc(u.id)}</b> ${
      u.is_admin ? "管理者" : ""
    }</span><span>${u.points} pt</span><button class="small" data-id="${
      esc(u.id)
    }">ポイント追加</button></div>`
  ).join("");
  document.querySelectorAll("[data-id]").forEach((b) =>
    b.onclick = async () => {
      const n = Number(prompt("追加ポイント", "100"));
      if (n) {
        await api(`/api/admin/users/${encodeURIComponent(b.dataset.id)}/points`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ points: n }),
        });
        loadUsers();
        refresh();
      }
    }
  );
}
function downloadMinutes(minutes) {
  const payload = {
    id: minutes.id,
    title: minutes.title,
    created_at: minutes.created_at,
    estimated_usd: minutes.estimated_usd,
    charged_points: minutes.charged_points,
    transcript: minutes.transcript,
    result: minutes.result,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `matomeru-${String(minutes.created_at).replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}
function setRealtimeJsonDownload(result, transcript, cost) {
  const link = $("#minutesJsonDownload");
  if (link.href) URL.revokeObjectURL(link.href);
  const data = {
    title: "リアルタイム会議",
    created_at: new Date().toISOString(),
    estimated_usd: cost.usd,
    charged_points: cost.points,
    transcript,
    result,
  };
  link.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  link.download = `matomeru-realtime-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.hidden = false;
}
async function loadHistory() {
  const minutes = await api("/api/minutes");
  const history = $("#history");
  if (!minutes.length) {
    history.className = "history empty";
    history.textContent = "まだ議事録はありません。";
    return;
  }
  history.className = "history";
  history.innerHTML = minutes.map((m) => {
    const date = new Date(m.created_at).toLocaleString("ja-JP");
    return `<article class="history-item"><div><div class="history-title">${esc(date)} — ${
      esc(m.result?.summary || m.title || "議事録")
    }</div><div class="hint">${
      esc(m.title)
    } ・ ${m.charged_points}pt</div></div><div class="history-actions"><button class="small" data-view-id="${m.id}">表示</button><button class="small" data-download-id="${m.id}">JSONをダウンロード</button></div></article>`;
  }).join("");
  history.querySelectorAll("[data-view-id]").forEach((button) => {
    button.onclick = () => {
      const selected = minutes.find((m) => String(m.id) === button.dataset.viewId);
      if (!selected) return;
      render(selected.result, selected.transcript);
      $("#minutesDialog").showModal();
    };
  });
  history.querySelectorAll("[data-download-id]").forEach((button) => {
    button.onclick = () =>
      downloadMinutes(minutes.find((m) => String(m.id) === button.dataset.downloadId));
  });
}
async function refresh() {
  const me = await api("/api/me");
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#points").textContent = me.points;
  $("#account").innerHTML =
    `<button id="accountTrigger" class="account-trigger"><span id="balance">${
      esc(me.id)
    } ・ 残高 <strong><span id="points">${me.points}</span> pt</strong></span></button> <button id="logout" class="small">ログアウト</button>`;
  $("#accountTrigger").onclick = async () => {
    $("#accountUserId").textContent = `ID: ${me.id}`;
    try {
      await loadPasskeys();
      $("#accountDialog").showModal();
    } catch (error) {
      alert(error.message);
    }
  };
  $("#logout").onclick = () => api("/api/logout", { method: "POST" }).then(() => location.reload());
  if (me.is_admin) {
    $("#admin").hidden = false;
    loadUsers();
  }
  await loadHistory();
}
$("#addPasskey").onclick = async () => {
  try {
    await addPasskey();
    await loadPasskeys();
    alert("パスキーを追加しました");
  } catch (error) {
    alert(error.message);
  }
};
$("#deleteAccount").onclick = async () => {
  if (!confirm("アカウントと保存済み議事録をすべて削除します。続行しますか？")) return;
  try {
    await api("/api/account", { method: "DELETE" });
    location.reload();
  } catch (error) {
    alert(error.message);
  }
};
$("#passkeyLoginButton").onclick = async () => {
  const status = $("#passkeyStatus");
  const button = $("#passkeyLoginButton");
  button.disabled = true;
  try {
    await passkeyLogin();
  } catch (error) {
    status.textContent = error.message;
    alert(error.message);
  } finally {
    button.disabled = false;
  }
};
$("#passkeyRegisterButton").onclick = async () => {
  if (!await showTerms()) return;
  const status = $("#passkeyStatus");
  const button = $("#passkeyRegisterButton");
  button.disabled = true;
  try {
    status.textContent = "登録中…";
    await passkeyRegister();
  } catch (error) {
    status.textContent = error.message;
    alert(error.message);
  } finally {
    button.disabled = false;
  }
};
$("#closeMinutes").onclick = () => $("#minutesDialog").close();
let liveSocket, liveContext, liveStream, liveProcessor, liveRecorder, liveText = "";
let liveAudioChunks = [];
let liveSpeaking = false, liveSilenceSince = null;
let livePaused = false;
let liveLimitTimer, liveLimitStartedAt;
const liveLimitMs = 60 * 60 * 1000;
function pcm16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = Math.max(-1, Math.min(1, input[i])) * (input[i] < 0 ? 32768 : 32767);
  }
  return btoa(String.fromCharCode(...new Uint8Array(out.buffer)));
}
function countdownText(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `残り ${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${
    String(Math.floor(seconds / 60) % 60).padStart(2, "0")
  }:${String(seconds % 60).padStart(2, "0")}`;
}
function startLiveLimit() {
  clearInterval(liveLimitTimer);
  liveLimitStartedAt = Date.now();
  const update = () => {
    const remaining = liveLimitMs - (Date.now() - liveLimitStartedAt);
    $("#liveStatus").textContent = `録音中… ${countdownText(remaining)}`;
    if (remaining <= 0) {
      clearInterval(liveLimitTimer);
      $("#livePause").click();
    }
  };
  update();
  liveLimitTimer = setInterval(update, 1000);
}
$("#liveButton").onclick = async () => {
  if (liveSocket) {
    if (liveRecorder?.state === "recording") liveRecorder.stop();
    const hadSpeech = liveSpeaking;
    liveSpeaking = false;
    livePaused = false;
    clearInterval(liveLimitTimer);
    liveProcessor.onaudioprocess = null;
    liveProcessor.disconnect();
    if (hadSpeech) {
      liveSocket.send(JSON.stringify({ type: "block.commit", endedAt: new Date().toISOString() }));
    }
    liveSocket.send(JSON.stringify({ type: "stop" }));
    $("#liveButton").disabled = true;
    $("#liveStatus").textContent = "要点を生成中…";
    return;
  }
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    liveAudioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    liveRecorder = new MediaRecorder(liveStream, { mimeType });
    liveRecorder.ondataavailable = (e) => {
      if (e.data.size) liveAudioChunks.push(e.data);
    };
    liveRecorder.onstop = () => {
      const blob = new Blob(liveAudioChunks, { type: mimeType });
      const link = $("#audioDownload");
      if (link.href) URL.revokeObjectURL(link.href);
      link.href = URL.createObjectURL(blob);
      link.download = `matomeru-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      link.hidden = false;
    };
    liveRecorder.start(1000);
    $("#audioDownload").hidden = true;
    $("#minutesJsonDownload").hidden = true;
    $("#liveTranscript").textContent = "";
    $("#liveBlocks").innerHTML = "";
    $("#liveOverall").hidden = true;
    $("#liveOverall").innerHTML = "";
    liveText = "";
    liveSpeaking = false;
    liveSilenceSince = null;
    liveContext = new AudioContext({ sampleRate: 24000 });
    const source = liveContext.createMediaStreamSource(liveStream);
    liveProcessor = liveContext.createScriptProcessor(4096, 1, 1);
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    liveSocket = new WebSocket(`${protocol}://${location.host}/api/realtime`);
    liveSocket.onopen = () => {
      liveProcessor.onaudioprocess = (e) => {
        if (!livePaused && liveSocket?.readyState === WebSocket.OPEN) {
          const samples = e.inputBuffer.getChannelData(0);
          let power = 0;
          for (const sample of samples) power += sample * sample;
          const isSpeech = Math.sqrt(power / samples.length) > 0.018;
          if (isSpeech) {
            liveSilenceSince = null;
            if (!liveSpeaking) {
              liveSpeaking = true;
              liveSocket.send(
                JSON.stringify({ type: "block.start", startedAt: new Date().toISOString() }),
              );
            }
          } else if (liveSpeaking) {
            liveSilenceSince ??= Date.now();
            if (Date.now() - liveSilenceSince >= 1500) {
              liveSpeaking = false;
              liveSocket.send(
                JSON.stringify({ type: "block.commit", endedAt: new Date().toISOString() }),
              );
            }
          }
          liveSocket.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: pcm16(samples),
            }),
          );
        }
      };
      source.connect(liveProcessor);
      liveProcessor.connect(liveContext.destination);
      $("#liveButton").textContent = "録音を停止";
      $("#livePause").hidden = false;
      $("#livePause").textContent = "一時停止";
      $("#liveButton").classList.add("recording");
      startLiveLimit();
    };
    liveSocket.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.delta) {
        liveText += m.delta;
        $("#liveTranscript").textContent = liveText;
      }
      if (m.type === "block.completed") {
        const b = m.block;
        $("#liveBlocks").insertAdjacentHTML(
          "beforeend",
          `<article class="live-block" data-block="${b.id}"><div class="live-block-meta">ブロック${b.id} ・ ${
            new Date(b.started_at).toLocaleTimeString()
          }開始 ・ ${
            Number(b.duration_seconds).toFixed(1)
          }秒 ・ ${b.speaker}</div><div class="live-block-text">${
            esc(b.text)
          }</div><div class="live-block-summary">要点を生成中…</div></article>`,
        );
        $("#liveBlocks").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
        liveText = "";
        $("#liveTranscript").textContent = "";
      }
      if (m.type === "block.summary") {
        const block = document.querySelector(`[data-block="${m.id}"] .live-block-summary`);
        if (block) block.textContent = `要点：${m.summary}`;
      }
      if (m.type === "minutes.update") {
        const analysis = m.analysis || {};
        const overall = $("#liveOverall");
        overall.hidden = false;
        overall.innerHTML = `<strong>議事録全体の要点</strong><p>${
          esc(analysis.summary || "分析中…")
        }</p><strong>深掘り候補3件</strong><ol>${
          (analysis.deepening || []).map((x) => `<li>${esc(x)}</li>`).join("")
        }</ol>`;
      }
      if (m.type === "usage.charged") {
        $("#points").textContent = Math.max(0, Number($("#points").textContent) - m.points);
        $("#liveStatus").textContent = `${m.minutes}分利用・${m.points}pt使用`;
      }
      if (m.type === "usage.limit") {
        if (!livePaused) $("#livePause").click();
        $("#liveStatus").textContent = `一時停止中… ${countdownText(0)}`;
      }
      if (m.type === "minutes.completed") {
        const overall = $("#liveOverall");
        overall.hidden = false;
        overall.innerHTML = `<strong>議事録全体の要点</strong><p>${
          esc(m.result.summary || "")
        }</p><strong>深掘り候補3件</strong><ol>${
          (m.result.deepening || []).map((x) => `<li>${esc(x)}</li>`).join("")
        }</ol>`;
        setRealtimeJsonDownload(m.result, m.transcript, m.cost);
        $("#points").textContent = Number($("#points").textContent) - m.cost.points;
        await loadHistory();
        $("#history").scrollIntoView({ behavior: "smooth", block: "start" });
        alert(`${m.cost.points}ptを使用しました（API料金目安 $${m.cost.usd}）`);
      }
      if (m.type === "error") alert(`${m.error}${m.detail ? `\n${m.detail}` : ""}`);
    };
    liveSocket.onclose = () => {
      liveStream?.getTracks().forEach((t) => t.stop());
      liveProcessor?.disconnect();
      liveContext?.close();
      liveSocket = null;
      $("#liveButton").disabled = false;
      $("#liveButton").textContent = "録音を開始";
      $("#liveButton").classList.remove("recording");
      $("#livePause").hidden = true;
      livePaused = false;
      clearInterval(liveLimitTimer);
      $("#liveStatus").textContent = "";
    };
  } catch (x) {
    alert(`マイクを開始できません: ${x.message}`);
    liveSocket = null;
  }
};
$("#livePause").onclick = async () => {
  if (!liveRecorder || !liveSocket) return;
  if (!livePaused && liveRecorder.state === "recording") {
    livePaused = true;
    liveRecorder.pause();
    liveSocket.send(JSON.stringify({ type: "pause" }));
    await liveContext?.suspend();
    $("#livePause").textContent = "録音を再開";
    clearInterval(liveLimitTimer);
    $("#liveStatus").textContent = `一時停止中… ${
      countdownText(liveLimitMs - (Date.now() - liveLimitStartedAt))
    }`;
  } else if (livePaused && liveRecorder.state === "paused") {
    livePaused = false;
    liveSocket.send(JSON.stringify({ type: "resume" }));
    await liveContext?.resume();
    liveRecorder.resume();
    $("#livePause").textContent = "一時停止";
    startLiveLimit();
  }
};
refresh().catch(() => {});
