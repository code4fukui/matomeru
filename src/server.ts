import { join } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { Base62UX } from "base62ux";
import { db, now, row, rows } from "./db.ts";
import {
  clearSessionCookie,
  createSession,
  currentUser,
  hashPassword,
  sessionCookie,
} from "./auth.ts";

const root = new URL("../", import.meta.url).pathname;
const port = Number(Deno.env.get("PORT") || 8000);
const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
const diarizeModel = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-transcribe-diarize";
const realtimeTranscriptionModel = Deno.env.get("OPENAI_REALTIME_TRANSCRIBE_MODEL") ||
  "gpt-live-transcribe";
const apiKey = Deno.env.get("OPENAI_API_KEY");
const pointsPerUsd = Number(Deno.env.get("POINTS_PER_USD") || 1700);
const realtimeTranscriptionUsdPerMinute = 0.017;
const adminUserId = Deno.env.get("ADMIN_USER_ID")?.trim() || "";
const passkeyRpName = Deno.env.get("PASSKEY_RP_NAME") || "matomeru";
type Result = {
  summary: string;
  deepening: string[];
  decisions: string[];
  actions: { task: string; owner: string; due: string }[];
  gaps: string[];
  speakers: string[];
};

function json(data: unknown, status = 200, headers = new Headers()) {
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}
function fail(message: string, status = 400) {
  return json({ error: message }, status);
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}
function decodeBase64url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
function randomId() {
  return Base62UX.encode(crypto.getRandomValues(new Uint8Array(16)));
}
function userIdBytes(userId: string): Uint8Array<ArrayBuffer> {
  const decoded = Base62UX.decode(userId);
  const bytes = new Uint8Array(decoded.length);
  bytes.set(decoded);
  return bytes;
}
function passkeyContext(request: Request) {
  const url = new URL(request.url);
  return {
    rpID: Deno.env.get("PASSKEY_RP_ID") || url.hostname,
    origin: Deno.env.get("PASSKEY_ORIGIN") || url.origin,
  };
}
async function body(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
async function openai(path: string, payload: unknown) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetch(`https://api.openai.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(payload instanceof FormData ? {} : { "content-type": "application/json" }),
    },
    body: payload instanceof FormData ? payload : JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`OpenAI request failed (${response.status})`);
  return await response.json();
}
function responseText(response: Record<string, unknown>) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const output = Array.isArray(response.output) ? response.output : [];
  const texts = output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? [text] : [];
    });
  });
  if (!texts.length) throw new Error("OpenAIからテキスト応答がありませんでした");
  return texts.join("");
}
function estimate(textLength: number, audioMinutes: number) {
  const usd = Math.max(
    0.01,
    audioMinutes * realtimeTranscriptionUsdPerMinute + textLength / 1_000_000 * 0.6 + 0.002,
  );
  return { usd: Number(usd.toFixed(4)), points: Math.max(10, Math.ceil(usd * pointsPerUsd)) };
}
async function transcribe(file: File) {
  const form = new FormData();
  form.append("file", file);
  form.append("model", diarizeModel);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");
  const result = await openai("audio/transcriptions", form);
  const segments = Array.isArray(result.segments) ? result.segments : [];
  return segments.length
    ? segments.map((s: { speaker?: string; text?: string }) =>
      `[${s.speaker || "話者"}] ${s.text || ""}`
    ).join("\n")
    : String(result.text || "");
}
async function makeMinutes(transcript: string): Promise<Result> {
  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      deepening: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
      decisions: { type: "array", items: { type: "string" } },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            task: { type: "string" },
            owner: { type: "string" },
            due: { type: "string" },
          },
          required: ["task", "owner", "due"],
          additionalProperties: false,
        },
      },
      gaps: { type: "array", items: { type: "string" } },
      speakers: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "deepening", "decisions", "actions", "gaps", "speakers"],
    additionalProperties: false,
  };
  const input =
    `次の会議文字起こしから日本語の議事録を作成してください。話者名は不明なら話者1などを維持。事実と推測を分け、期限や担当者が不明なら「未定」としてください。決定事項、次のアクション、ヌケモレ・要確認事項を抽出し、さらに議論を深めた方がよい事項を重要度順に必ず3つ挙げてください。JSONのみで返してください。\n${transcript}`;
  const response = await openai("responses", {
    model,
    input,
    text: { format: { type: "json_schema", name: "meeting_minutes", strict: true, schema } },
    store: false,
  });
  return JSON.parse(responseText(response));
}
async function summarizeBlock(transcript: string) {
  const response = await openai("responses", {
    model,
    input:
      `次の会議発言ブロックの要点を日本語で1〜2文にまとめてください。事実だけをまとめてください。\n${transcript}`,
    store: false,
  });
  return responseText(response).trim();
}
async function analyzeRealtime(transcript: string): Promise<Pick<Result, "summary" | "deepening">> {
  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      deepening: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
    },
    required: ["summary", "deepening"],
    additionalProperties: false,
  };
  const response = await openai("responses", {
    model,
    input:
      `ここまでの会議文字起こしを読み、議事録全体の要点と、これから議論を深めた方がよい事項を重要度順に3つ、日本語で更新してください。まだ情報が少ない場合も、確認すべき論点を3つ挙げてください。JSONのみで返してください。\n${transcript}`,
    text: { format: { type: "json_schema", name: "realtime_analysis", strict: true, schema } },
    store: false,
  });
  return JSON.parse(responseText(response));
}
function realtime(request: Request, user: { id: string; points: number }) {
  if (!apiKey) return fail("OPENAI_API_KEY is not configured", 503);
  const { socket, response } = Deno.upgradeWebSocket(request);
  const upstream = new WebSocket(
    "wss://api.openai.com/v1/realtime?intent=transcription",
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  let transcript = "";
  let stopping = false;
  let finalized = false;
  const startedAt = Date.now();
  let chargedPoints = 0;
  let chargedMinutes = 0;
  let pausedAt: number | undefined;
  let pausedMilliseconds = 0;
  let limitReached = false;
  let currentTranscript = "";
  let currentBlockStart: string | undefined;
  const blockQueue: { startedAt: string; endedAt: string }[] = [];
  const blocks: (Record<string, unknown> & { text: string })[] = [];
  let pendingSummaries = 0;
  let pendingAnalyses = 0;
  let analysisVersion = 0;
  const send = (message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const chargeUsage = () => {
    const pauseNow = pausedAt === undefined ? 0 : Date.now() - pausedAt;
    const minutes = Math.floor((Date.now() - startedAt - pausedMilliseconds - pauseNow) / 60000);
    const newMinutes = minutes - chargedMinutes;
    if (newMinutes <= 0) return true;
    const points = Math.ceil(newMinutes * realtimeTranscriptionUsdPerMinute * pointsPerUsd);
    const result = db.prepare(
      "UPDATE users SET points=points-?,updated_at=? WHERE id=? AND points>=?",
    ).run(points, now(), user.id, points);
    if (result.changes !== 1) {
      send({
        type: "error",
        error: "ポイント不足です",
        detail: "リアルタイム議事録を継続できません",
      });
      if (usageTimer !== undefined) clearInterval(usageTimer);
      socket.close();
      return false;
    }
    chargedMinutes = minutes;
    chargedPoints += points;
    send({ type: "usage.charged", points, minutes: chargedMinutes });
    if (chargedMinutes >= 60 && !limitReached) {
      limitReached = true;
      pausedAt = Date.now();
      send({ type: "usage.limit" });
    }
    return true;
  };
  const finish = async () => {
    if (finalized || !stopping || blockQueue.length || pendingSummaries || pendingAnalyses) return;
    finalized = true;
    if (usageTimer !== undefined) clearInterval(usageTimer);
    if (!transcript.trim()) {
      socket.close();
      return;
    }
    const pauseNow = pausedAt === undefined ? 0 : Date.now() - pausedAt;
    const activeMinutes = (Date.now() - startedAt - pausedMilliseconds - pauseNow) / 60000;
    const cost = estimate(transcript.length, Math.max(1 / 60, activeMinutes));
    const remainingPoints = Math.max(0, cost.points - chargedPoints);
    if (user.points < chargedPoints + remainingPoints) {
      send({ type: "error", error: "ポイント不足です" });
      socket.close();
      return;
    }
    try {
      const result = await makeMinutes(transcript);
      const t = now();
      db.exec("BEGIN");
      db.prepare("UPDATE users SET points=points-?,updated_at=? WHERE id=?").run(
        remainingPoints,
        t,
        user.id,
      );
      db.prepare(
        "INSERT INTO minutes(user_id,title,transcript,result_json,estimated_usd,charged_points,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        user.id,
        "リアルタイム会議",
        transcript,
        JSON.stringify({ ...result, blocks }),
        cost.usd,
        chargedPoints + remainingPoints,
        t,
      );
      db.exec("COMMIT");
      send({
        type: "minutes.completed",
        result: { ...result, blocks },
        transcript,
        cost: { ...cost, points: remainingPoints, total_points: chargedPoints + remainingPoints },
      });
      socket.close();
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch { /* no-op */ }
      send({ type: "error", error: "要点の生成に失敗しました" });
      socket.close();
    }
  };
  upstream.onopen = () =>
    upstream.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: realtimeTranscriptionModel, languages: ["ja"], delay: "low" },
              turn_detection: null,
            },
          },
        },
      }),
    );
  const usageTimer = setInterval(chargeUsage, 15000);
  upstream.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "conversation.item.input_audio_transcription.delta") {
      const delta = typeof message.delta === "string" ? message.delta : "";
      transcript += delta;
      currentTranscript += delta;
    }
    if (
      message.type?.includes("input_audio_transcription") && socket.readyState === WebSocket.OPEN
    ) {
      socket.send(
        JSON.stringify({
          type: message.type,
          delta: message.delta,
          transcript: message.transcript,
        }),
      );
    }
    if (message.type === "error") {
      console.error("OpenAI Realtime error:", JSON.stringify(message.error ?? message));
    }
    if (message.type === "error" && socket.readyState === WebSocket.OPEN) {
      const detail = typeof message.error?.message === "string"
        ? message.error.message
        : "接続設定またはモデルを確認してください";
      socket.send(
        JSON.stringify({ type: "error", error: "Realtime transcription failed", detail }),
      );
    }
    if (message.type === "conversation.item.input_audio_transcription.completed") {
      const meta = blockQueue.shift() ||
        { startedAt: new Date(startedAt).toISOString(), endedAt: now() };
      const completedTranscript = typeof message.transcript === "string"
        ? message.transcript.trim()
        : "";
      const text = completedTranscript || currentTranscript.trim();
      currentTranscript = "";
      if (!text) {
        finish();
        return;
      }
      const block: Record<string, unknown> & { text: string; summary?: string } = {
        id: blocks.length + 1,
        started_at: meta.startedAt,
        ended_at: meta.endedAt,
        duration_seconds: Math.max(
          0,
          (Date.parse(meta.endedAt) - Date.parse(meta.startedAt)) / 1000,
        ),
        speaker: `話者切替候補 ${blocks.length + 1}`,
        text,
      };
      blocks.push(block);
      pendingSummaries++;
      send({ type: "block.completed", block });
      summarizeBlock(text).then((summary) => {
        block.summary = summary;
        send({ type: "block.summary", id: block.id, summary });
      }).catch(() =>
        send({ type: "block.summary", id: block.id, summary: "要点を取得できませんでした" })
      ).finally(() => {
        pendingSummaries--;
        finish();
      });
      const version = ++analysisVersion;
      pendingAnalyses++;
      analyzeRealtime(transcript).then((analysis) => {
        if (version === analysisVersion) send({ type: "minutes.update", analysis });
      }).catch(() => {
        if (version === analysisVersion) {
          send({ type: "minutes.update", analysis: { summary: "分析中…", deepening: [] } });
        }
      }).finally(() => {
        pendingAnalyses--;
        finish();
      });
      finish();
    }
  };
  upstream.onerror = () => {
    console.error("OpenAI Realtime WebSocket error");
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "error",
          error: "Realtime connection failed",
          detail: "OpenAIへのWebSocket接続に失敗しました",
        }),
      );
    }
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (stopping && message.type === "input_audio_buffer.append") return;
    if (message.type === "block.start") {
      if (!currentBlockStart) {
        currentBlockStart = typeof message.startedAt === "string" ? message.startedAt : now();
      }
    } else if (message.type === "pause") {
      if (pausedAt === undefined) pausedAt = Date.now();
    } else if (message.type === "resume") {
      if (pausedAt !== undefined) {
        pausedMilliseconds += Date.now() - pausedAt;
        pausedAt = undefined;
      }
      limitReached = false;
    } else if (message.type === "block.commit") {
      const endedAt = typeof message.endedAt === "string" ? message.endedAt : now();
      blockQueue.push({ startedAt: currentBlockStart || endedAt, endedAt });
      currentBlockStart = undefined;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
    } else if (message.type === "stop") {
      stopping = true;
      if (pausedAt !== undefined) {
        pausedMilliseconds += Date.now() - pausedAt;
        pausedAt = undefined;
      }
      if (currentBlockStart) {
        blockQueue.push({ startedAt: currentBlockStart, endedAt: now() });
        currentBlockStart = undefined;
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
      }
      finish();
    } else if (upstream.readyState === WebSocket.OPEN) upstream.send(event.data);
  };
  socket.onclose = () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  };
  return response;
}
async function api(request: Request, url: URL) {
  if (url.pathname === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, new Headers({ "set-cookie": clearSessionCookie() }));
  }
  if (url.pathname === "/api/passkey/register/options" && request.method === "POST") {
    const context = passkeyContext(request);
    const bootstrapAdmin = adminUserId && row<{ count: number }>(
          "SELECT COUNT(*) AS count FROM passkeys WHERE user_id=?",
          adminUserId,
        )?.count === 0
      ? adminUserId
      : randomId();
    const userId = bootstrapAdmin || randomId();
    const existing = rows<{ id: string; transports: string }>(
      "SELECT id,transports FROM passkeys WHERE user_id=?",
      userId,
    );
    const options = await generateRegistrationOptions({
      rpName: passkeyRpName,
      rpID: context.rpID,
      userName: userId,
      userID: userIdBytes(userId),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.id,
        transports: JSON.parse(p.transports),
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = randomId();
    db.prepare(
      "INSERT INTO auth_challenges(id,user_id,challenge,kind,expires_at,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      challengeId,
      userId,
      options.challenge,
      "registration",
      new Date(Date.now() + 300000).toISOString(),
      now(),
    );
    return json({ challengeId, userId, options });
  }
  if (url.pathname === "/api/passkey/register/verify" && request.method === "POST") {
    const b = await body(request);
    const challengeId = typeof b?.challengeId === "string" ? b.challengeId : "";
    const challenge = row<{ user_id: string; challenge: string }>(
      "SELECT user_id,challenge FROM auth_challenges WHERE id=? AND kind='registration' AND expires_at>?",
      challengeId,
      now(),
    );
    if (!challenge || b?.termsAccepted !== true || !b?.response || typeof b.response !== "object") {
      return fail(
        !challenge ? "パスキー登録の有効期限が切れています" : "利用規約への同意が必要です",
        400,
      );
    }
    const existingUser = row("SELECT id FROM users WHERE id=?", challenge.user_id);
    if (existingUser && currentUser(request)?.id !== challenge.user_id) {
      return fail("認証が必要です", 401);
    }
    db.prepare("DELETE FROM auth_challenges WHERE id=?").run(challengeId);
    try {
      const context = passkeyContext(request);
      const verification = await verifyRegistrationResponse({
        response: b.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: context.origin,
        expectedRPID: context.rpID,
        requireUserVerification: false,
      });
      if (!verification.verified || !verification.registrationInfo) {
        return fail("パスキー登録を確認できませんでした", 400);
      }
      const credential = verification.registrationInfo.credential;
      if (!row("SELECT id FROM users WHERE id=?", challenge.user_id)) {
        const t = now();
        db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?)").run(
          challenge.user_id,
          await hashPassword(randomId()),
          0,
          0,
          100,
          t,
          t,
        );
      }
      db.prepare(
        "INSERT INTO passkeys(id,user_id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        credential.id,
        challenge.user_id,
        base64url(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports || []),
        now(),
      );
      return json(
        { ok: true, userId: challenge.user_id },
        200,
        new Headers({ "set-cookie": sessionCookie(createSession(challenge.user_id)) }),
      );
    } catch {
      return fail("パスキー登録に失敗しました", 400);
    }
  }
  if (url.pathname === "/api/passkey/login/options" && request.method === "POST") {
    const context = passkeyContext(request);
    const options = await generateAuthenticationOptions({
      rpID: context.rpID,
      userVerification: "preferred",
    });
    const challengeId = randomId();
    db.prepare(
      "INSERT INTO auth_challenges(id,user_id,challenge,kind,expires_at,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      challengeId,
      null,
      options.challenge,
      "authentication",
      new Date(Date.now() + 300000).toISOString(),
      now(),
    );
    return json({ challengeId, options });
  }
  if (url.pathname === "/api/passkey/login/verify" && request.method === "POST") {
    const b = await body(request);
    const challengeId = typeof b?.challengeId === "string" ? b.challengeId : "";
    const credentialId = typeof b?.response?.id === "string" ? b.response.id : "";
    const challenge = row<{ challenge: string }>(
      "SELECT challenge FROM auth_challenges WHERE id=? AND kind='authentication' AND expires_at>?",
      challengeId,
      now(),
    );
    const credential = row<{
      id: string;
      user_id: string;
      public_key: string;
      counter: number;
      transports: string;
    }>("SELECT id,user_id,public_key,counter,transports FROM passkeys WHERE id=?", credentialId);
    if (!challenge || !credential || !b?.response || typeof b.response !== "object") {
      return fail("パスキーでログインできませんでした", 401);
    }
    db.prepare("DELETE FROM auth_challenges WHERE id=?").run(challengeId);
    try {
      const context = passkeyContext(request);
      const verification = await verifyAuthenticationResponse({
        response: b.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: context.origin,
        expectedRPID: context.rpID,
        credential: {
          id: credential.id,
          publicKey: decodeBase64url(credential.public_key),
          counter: credential.counter,
          transports: JSON.parse(credential.transports),
        },
        requireUserVerification: false,
      });
      if (!verification.verified) return fail("パスキーでログインできませんでした", 401);
      db.prepare("UPDATE passkeys SET counter=? WHERE id=?").run(
        verification.authenticationInfo.newCounter,
        credential.id,
      );
      return json(
        { ok: true },
        200,
        new Headers({ "set-cookie": sessionCookie(createSession(credential.user_id)) }),
      );
    } catch {
      return fail("パスキーでログインできませんでした", 401);
    }
  }
  const user = currentUser(request);
  if (!user) return fail("Unauthorized", 401);
  if (url.pathname === "/api/me") return json(user);
  if (url.pathname === "/api/passkeys" && request.method === "GET") {
    return json(
      rows<{ id: string; created_at: string }>(
        "SELECT id,created_at FROM passkeys WHERE user_id=? ORDER BY created_at",
        user.id,
      ),
    );
  }
  if (url.pathname === "/api/passkey/add/options" && request.method === "POST") {
    const context = passkeyContext(request);
    const existing = rows<{ id: string; transports: string }>(
      "SELECT id,transports FROM passkeys WHERE user_id=?",
      user.id,
    );
    const options = await generateRegistrationOptions({
      rpName: passkeyRpName,
      rpID: context.rpID,
      userName: user.id,
      userID: userIdBytes(user.id),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = randomId();
    db.prepare(
      "INSERT INTO auth_challenges(id,user_id,challenge,kind,expires_at,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      challengeId,
      user.id,
      options.challenge,
      "registration",
      new Date(Date.now() + 300000).toISOString(),
      now(),
    );
    return json({ challengeId, options });
  }
  if (url.pathname === "/api/passkey/add/verify" && request.method === "POST") {
    const b = await body(request);
    const challengeId = typeof b?.challengeId === "string" ? b.challengeId : "";
    const challenge = row<{ user_id: string; challenge: string }>(
      "SELECT user_id,challenge FROM auth_challenges WHERE id=? AND kind='registration' AND expires_at>?",
      challengeId,
      now(),
    );
    if (
      !challenge || challenge.user_id !== user.id || !b?.response || typeof b.response !== "object"
    ) {
      return fail("パスキー追加の有効期限が切れています", 400);
    }
    db.prepare("DELETE FROM auth_challenges WHERE id=?").run(challengeId);
    try {
      const context = passkeyContext(request);
      const verification = await verifyRegistrationResponse({
        response: b.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: context.origin,
        expectedRPID: context.rpID,
        requireUserVerification: false,
      });
      if (!verification.verified || !verification.registrationInfo) {
        return fail("パスキーを追加できませんでした", 400);
      }
      const credential = verification.registrationInfo.credential;
      db.prepare(
        "INSERT INTO passkeys(id,user_id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        credential.id,
        user.id,
        base64url(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports || []),
        now(),
      );
      return json({ ok: true });
    } catch {
      return fail("パスキーを追加できませんでした", 400);
    }
  }
  const passkeyDelete = url.pathname.match(/^\/api\/passkeys\/([^/]+)$/);
  if (passkeyDelete && request.method === "DELETE") {
    const id = decodeURIComponent(passkeyDelete[1]);
    const count = row<{ count: number }>(
      "SELECT COUNT(*) AS count FROM passkeys WHERE user_id=?",
      user.id,
    )?.count || 0;
    if (count <= 1) return fail("最後のパスキーは削除できません", 400);
    db.prepare("DELETE FROM passkeys WHERE id=? AND user_id=?").run(id, user.id);
    return json({ ok: true });
  }
  if (url.pathname === "/api/account" && request.method === "DELETE") {
    db.prepare("DELETE FROM users WHERE id=?").run(user.id);
    return json({ ok: true }, 200, new Headers({ "set-cookie": clearSessionCookie() }));
  }
  if (url.pathname === "/api/minutes" && request.method === "GET") {
    return json(
      rows<{ result_json: string }>(
        "SELECT id,title,transcript,result_json,estimated_usd,charged_points,created_at FROM minutes WHERE user_id=? ORDER BY id DESC",
        user.id,
      ).map((m) => ({ ...m, result: JSON.parse(m.result_json) })),
    );
  }
  if (url.pathname === "/api/minutes" && request.method === "POST") {
    const form = await request.formData();
    const title = String(form.get("title") || "無題の会議").slice(0, 120);
    const text = String(form.get("transcript") || "").slice(0, 200_000);
    const file = form.get("audio");
    let transcript = text;
    if (file instanceof File && file.size) transcript = await transcribe(file);
    if (!transcript.trim()) return fail("音声ファイルまたは文字起こしを入力してください");
    const cost = estimate(
      transcript.length,
      file instanceof File ? Math.max(1, file.size / 16000 / 60) : 0,
    );
    if (user.points < cost.points) {
      return fail(`ポイント不足です（必要 ${cost.points}pt / 残高 ${user.points}pt）`, 402);
    }
    try {
      const result = await makeMinutes(transcript);
      const t = now();
      db.exec("BEGIN");
      db.prepare("UPDATE users SET points=points-?,updated_at=? WHERE id=?").run(
        cost.points,
        t,
        user.id,
      );
      db.prepare(
        "INSERT INTO minutes(user_id,title,transcript,result_json,estimated_usd,charged_points,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(user.id, title, transcript, JSON.stringify(result), cost.usd, cost.points, t);
      db.exec("COMMIT");
      return json({ result, transcript, cost });
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch { /* no-op */ }
      return fail(e instanceof Error ? e.message : "生成に失敗しました", 502);
    }
  }
  if (!user.is_admin) return fail("Forbidden", 403);
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    return json(
      rows(
        "SELECT id,CASE WHEN ? <> '' AND id=? THEN 1 ELSE 0 END AS is_admin,must_change_password,points,created_at FROM users ORDER BY id",
        adminUserId,
        adminUserId,
      ),
    );
  }
  const add = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/points$/);
  if (add && request.method === "POST") {
    const b = await body(request);
    const points = Number(b?.points);
    if (!Number.isInteger(points) || points < 1 || points > 1_000_000) {
      return fail("ポイントは1〜1,000,000の整数で指定してください");
    }
    db.prepare("UPDATE users SET points=points+?,updated_at=? WHERE id=?").run(
      points,
      now(),
      decodeURIComponent(add[1]),
    );
    return json({ ok: true });
  }
  return fail("Not found", 404);
}
async function handler(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/realtime" && request.headers.get("upgrade") === "websocket") {
    const user = currentUser(request);
    if (!user) return fail("Unauthorized", 401);
    return realtime(request, user);
  }
  if (url.pathname.startsWith("/api/")) return api(request, url);
  const path = url.pathname === "/"
    ? join(root, "public/index.html")
    : join(root, "public", url.pathname.slice(1));
  try {
    const file = await Deno.readFile(path);
    const type = path.endsWith(".html")
      ? "text/html"
      : path.endsWith(".js")
      ? "text/javascript"
      : "text/css";
    return new Response(file, { headers: { "content-type": `${type}; charset=utf-8` } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
console.log(`matomeru listening on http://localhost:${port}`);
Deno.serve({ port }, handler);
