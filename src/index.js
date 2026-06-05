const CLUB_ID = "47";
const ACTIVITY_ID = 41601;
const VAPI_BASE = "https://vapi.virginactive.com/vapi/2.0.1";

const AUTH_URL = `${VAPI_BASE}/sessions`;

const WINDOW_START = 7 * 60 + 30; // 07:30 in minutes
const WINDOW_END = 20 * 60 + 30;  // 20:30 in minutes
const BOOKING_RELEASE_END = 7 * 60 + 35; // always run within 07:30–07:35 regardless of random timer

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TIME_PRESETS = [
  ["07:00–09:00", "08:00–10:00"],
  ["09:00–11:00", "10:00–12:00"],
  ["12:00–14:00", "14:00–16:00"],
  ["17:00–19:00", "18:00–20:00"],
];

const STATIC_HEADERS = {
  "x-app-id": "2BoKHJPfAB",
  "x-newrelic-id": "XAAGUlJSGwIIV1RTAwUBX1A=",
  "x-api-key": "3b2ba10c-621a-4fd3-bcca-c12b4f4c65bc",
  "x-va-region": "GBR",
  "x-app-version": "4.3.11 (426042800)",
  lang_pref: "en",
  "user-agent": "Ktor client",
  accept: "application/json, application/json",
  "accept-language": "en-GB,en;q=0.9",
  "accept-charset": "UTF-8",
  "accept-encoding": "gzip, deflate, br",
};

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkAvailability(env, controller));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === `/webhook/${env.TELEGRAM_BOT_TOKEN}` && request.method === "POST") {
      const update = await request.json();
      await handleTelegramUpdate(update, env);
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/test-notify") {
      const fakeController = { scheduledTime: Date.now() };
      await notify(env, buildMessage([], fakeController, Date.now() + 30 * 60 * 1000));
      return new Response("Notification sent", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── Telegram bot ──────────────────────────────────────────────────────────────

async function handleTelegramUpdate(update, env) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const msg = update.message ?? update.channel_post;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split("@")[0].toLowerCase();

  // Check if we're waiting for a custom time from this user
  const convoRaw = await env.STATE.get(`convo:${chatId}`);
  if (convoRaw) {
    const convo = JSON.parse(convoRaw);
    if (convo.step === "awaiting_custom_time" && !cmd.startsWith("/")) {
      const match = text.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
      if (!match) {
        await sendMessage(env, chatId, "Couldn't parse that. Enter a range like: 14:00-16:00");
        return;
      }
      const [, from, to] = match;
      await startDaySelection(env, chatId, from, to);
      return;
    }
  }

  if (cmd === "/next") {
    const nextCheck = parseInt((await env.STATE.get("next-check-time")) ?? "0");
    const reply =
      nextCheck > Date.now()
        ? `Next check scheduled for: ${fmt(new Date(nextCheck))}`
        : "Next check will run on the next heartbeat (within 5 minutes).";
    await sendMessage(env, chatId, reply);
    return;
  }

  if (cmd === "/last") {
    const lastRun = await env.STATE.get("last-run");
    const nextCheck = parseInt((await env.STATE.get("next-check-time")) ?? "0");
    const reply = lastRun
      ? `Last check: ${fmt(new Date(lastRun))}\nNext check: ${nextCheck > Date.now() ? fmt(new Date(nextCheck)) : "imminent"}`
      : "No check has run yet.";
    await sendMessage(env, chatId, reply);
    return;
  }

  if (cmd.startsWith("/book")) {
    const args = text.slice(cmd.length).trim();

    if (args === "cancel") {
      await env.STATE.delete("booking-pref");
      await env.STATE.delete(`convo:${chatId}`);
      await sendMessage(env, chatId, "Booking preference cancelled.");
      return;
    }

    if (args === "status") {
      const pref = await env.STATE.get("booking-pref", { type: "json" });
      if (!pref) {
        await sendMessage(env, chatId, "No booking preference set. Send /book to set one.");
      } else {
        const daysText = pref.days?.length > 0 ? pref.days.join(", ") : "any day";
        await sendMessage(env, chatId, `Current: ${pref.from}–${pref.to} on ${daysText}\n\nSend /book cancel to remove.`);
      }
      return;
    }

    // Launch interactive flow
    await sendMessageWithKeyboard(env, chatId, "When would you like to play?", buildTimeKeyboard());
    return;
  }

  if (cmd === "/log") {
    const log = await env.STATE.get("slot-log", { type: "json" });
    if (!log || log.length === 0) {
      await sendMessage(env, chatId, "No slots seen yet since the last deploy.");
      return;
    }
    const lines = log.slice(0, 10).map((e) => {
      const slotList = e.slots.join(", ");
      const prefNote = e.pref ? ` (pref: ${e.pref})` : " (no pref set)";
      const matchNote = e.matched.length > 0 ? ` ✅ matched: ${e.matched.join(", ")}` : " ❌ no match";
      return `${fmt(new Date(e.at))}\n  Slots: ${slotList}${prefNote}${matchNote}`;
    });
    await sendMessage(env, chatId, `Last ${lines.length} checks with open slots:\n\n${lines.join("\n\n")}`);
    return;
  }

  if (cmd === "/help") {
    await sendMessage(
      env,
      chatId,
      "/book — set up auto-booking interactively\n/book status — show current preference\n/book cancel — cancel auto-booking\n/next — when is the next check\n/last — when was the last check\n/log — history of checks where slots were found",
    );
  }
}

async function handleCallbackQuery(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const convoKey = `convo:${chatId}`;

  await answerCallbackQuery(env, query.id);

  // Time preset selected
  if (data.startsWith("time:")) {
    const range = data.slice(5); // "08:00–10:00"
    const [from, to] = range.split("–");
    await env.STATE.put(convoKey, JSON.stringify({ step: "awaiting_days", from, to, days: [], messageId }), { expirationTtl: 1800 });
    await editMessageText(env, chatId, messageId, `Time: ${from}–${to}\n\nWhich days are you free?`, buildDayKeyboard([]));
    return;
  }

  // Custom time entry
  if (data === "time:custom") {
    await env.STATE.put(convoKey, JSON.stringify({ step: "awaiting_custom_time" }), { expirationTtl: 1800 });
    await editMessageText(env, chatId, messageId, "Type your preferred time range, e.g: 14:00-16:00");
    return;
  }

  // Day toggled
  if (data.startsWith("day:")) {
    const convoRaw = await env.STATE.get(convoKey);
    if (!convoRaw) {
      await sendMessage(env, chatId, "Session expired — send /book to start again.");
      return;
    }
    const convo = JSON.parse(convoRaw);
    const day = data.slice(4);

    if (day === "any") {
      convo.days = [];
    } else if (convo.days.includes(day)) {
      convo.days = convo.days.filter((d) => d !== day);
    } else {
      convo.days.push(day);
    }

    await env.STATE.put(convoKey, JSON.stringify(convo), { expirationTtl: 1800 });
    await editMessageReplyMarkup(env, chatId, messageId, buildDayKeyboard(convo.days));
    return;
  }

  // Confirm booking preference
  if (data === "days:confirm") {
    const convoRaw = await env.STATE.get(convoKey);
    if (!convoRaw) {
      await sendMessage(env, chatId, "Session expired — send /book to start again.");
      return;
    }
    const convo = JSON.parse(convoRaw);
    await env.STATE.delete(convoKey);
    await env.STATE.put("booking-pref", JSON.stringify({ from: convo.from, to: convo.to, days: convo.days }));
    const daysText = convo.days.length > 0 ? convo.days.join(", ") : "any day";
    await editMessageText(env, chatId, messageId, `✅ Set: ${convo.from}–${convo.to} on ${daysText}\n\nI'll book the first available court matching this.`);
  }
}

async function startDaySelection(env, chatId, from, to) {
  const convoKey = `convo:${chatId}`;
  const res = await sendMessageWithKeyboard(env, chatId, `Time: ${from}–${to}\n\nWhich days are you free?`, buildDayKeyboard([]));
  const messageId = res?.result?.message_id;
  await env.STATE.put(convoKey, JSON.stringify({ step: "awaiting_days", from, to, days: [], messageId }), { expirationTtl: 1800 });
}

// ── Keyboard builders ─────────────────────────────────────────────────────────

function buildTimeKeyboard() {
  return {
    inline_keyboard: [
      ...TIME_PRESETS.map((row) =>
        row.map((t) => ({ text: t, callback_data: `time:${t}` }))
      ),
      [{ text: "✏️ Custom range", callback_data: "time:custom" }],
    ],
  };
}

function buildDayKeyboard(selected) {
  const anyDay = selected.length === 0;
  const weekdays = DAY_NAMES.slice(1); // Mon–Sun

  return {
    inline_keyboard: [
      weekdays.slice(0, 4).map((d) => ({
        text: selected.includes(d) ? `✅ ${d}` : d,
        callback_data: `day:${d}`,
      })),
      weekdays.slice(4).map((d) => ({
        text: selected.includes(d) ? `✅ ${d}` : d,
        callback_data: `day:${d}`,
      })),
      [{ text: anyDay ? "✅ Any day" : "Any day", callback_data: "day:any" }],
      [{ text: "Confirm ✓", callback_data: "days:confirm" }],
    ],
  };
}

// ── Telegram API helpers ──────────────────────────────────────────────────────

async function sendMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function sendMessageWithKeyboard(env, chatId, text, replyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
  });
  return res.json();
}

async function editMessageText(env, chatId, messageId, text, replyMarkup = null) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function editMessageReplyMarkup(env, chatId, messageId, replyMarkup) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
  });
}

async function answerCallbackQuery(env, callbackQueryId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// ── Scheduling & availability ─────────────────────────────────────────────────

function londonMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const h = parseInt(parts.find((p) => p.type === "hour").value);
  const m = parseInt(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}

function randomDelayMs() {
  return (15 + Math.floor(Math.random() * 31)) * 60 * 1000;
}

async function checkAvailability(env, controller) {
  const now = Date.now();
  const nowMins = londonMinutes(new Date(now));

  if (nowMins < WINDOW_START || nowMins > WINDOW_END) return;

  const isBookingRelease = nowMins >= WINDOW_START && nowMins <= BOOKING_RELEASE_END;
  const nextCheck = parseInt((await env.STATE.get("next-check-time")) ?? "0");
  if (!isBookingRelease && now < nextCheck) return;

  const nextCheckTime = now + randomDelayMs();
  await env.STATE.put("next-check-time", String(nextCheckTime));

  let token;
  try {
    token = await getAuthToken(env);
    await env.STATE.delete("auth-error-notified");
  } catch (err) {
    console.error(`Auth failed: ${err.message}`);
    if (!await env.STATE.get("auth-error-notified")) {
      await env.STATE.put("auth-error-notified", "1");
      await notify(env, `⚠️ Auth failed: ${err.message}`);
    }
    return;
  }

  // Check each date in the 7-day booking window
  const slots = [];
  let apiErrored = false;
  for (let i = 0; i <= 7; i++) {
    const date = toDateString(now + i * 24 * 60 * 60 * 1000);
    const url = `${VAPI_BASE}/clubs/${CLUB_ID}/activity/${ACTIVITY_ID}?date=${date}`;
    try {
      let res = await fetch(url, { headers: authHeaders(token) });
      if (res.status === 401) {
        await env.STATE.delete("auth:token");
        token = await getAuthToken(env);
        res = await fetch(url, { headers: authHeaders(token) });
      }
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          for (const slot of data) {
            if (slot.isAvailable) slots.push({ ...slot, date });
          }
        }
      } else {
        console.error(`API error for ${date}: ${res.status}`);
        apiErrored = true;
      }
    } catch (err) {
      console.error(`Fetch failed for ${date}: ${err.message}`);
    }
  }

  if (apiErrored && slots.length === 0) {
    if (!await env.STATE.get("api-error-notified")) {
      await env.STATE.put("api-error-notified", "1");
      await notify(env, `⚠️ API error fetching court availability`);
    }
    return;
  }
  await env.STATE.delete("api-error-notified");

  // If a booking preference is set, try to book a matching slot
  const pref = await env.STATE.get("booking-pref", { type: "json" });
  if (pref && slots.length > 0) {
    const match = slots.find((s) => slotMatchesPref(s, pref));
    if (match) {
      const bookDate = match.date;
      const bookTime = match.time;
      const result = await attemptBooking(env, token, bookDate, bookTime);
      if (result.success) {
        await env.STATE.delete("booking-pref");
        await notify(env, `✅ Booked! Tennis court on ${bookDate} at ${result.time} (${result.court})`);
      } else {
        console.error(`Booking attempt failed for ${bookDate} ${bookTime}: ${result.reason}`);
      }
    }
  }

  // Log any seen slots (whether booked, skipped, or no pref set)
  if (slots.length > 0) {
    await appendSlotLog(env, now, slots, pref);
  }

  await notify(env, buildMessage(slots, controller, nextCheckTime));
  await env.STATE.put("last-run", new Date(now).toISOString());
}

async function appendSlotLog(env, now, slots, pref) {
  const existing = await env.STATE.get("slot-log", { type: "json" }) ?? [];
  const matched = pref ? slots.filter((s) => slotMatchesPref(s, pref)).map((s) => `${s.date} ${s.time}`) : [];
  const entry = {
    at: new Date(now).toISOString(),
    slots: slots.map((s) => `${s.date} ${s.time}`),
    pref: pref ? `${pref.from}–${pref.to} on ${pref.days?.join(",")||"any day"}` : null,
    matched,
  };
  const updated = [entry, ...existing].slice(0, 30);
  await env.STATE.put("slot-log", JSON.stringify(updated));
}

// ── Booking ───────────────────────────────────────────────────────────────────

function normaliseDay(d) {
  return DAY_NAMES.find((n) => n.toLowerCase() === d.slice(0, 3).toLowerCase()) ?? null;
}

function slotMatchesPref(slot, pref) {
  const time = extractSlotTime(slot);
  if (!time) return false;

  const [sh, sm] = time.split(":").map(Number);
  const [fh, fm] = pref.from.split(":").map(Number);
  const [th, tm] = pref.to.split(":").map(Number);
  const slotMins = sh * 60 + sm;
  if (slotMins < fh * 60 + fm || slotMins >= th * 60 + tm) return false;

  if (pref.days?.length > 0) {
    const date = extractSlotDate(slot);
    if (!date) return false;
    const dayName = DAY_NAMES[new Date(date + "T12:00:00Z").getUTCDay()];
    if (!pref.days.includes(dayName)) return false;
  }

  return true;
}

function extractSlotDate(slot) {
  return slot.date ?? "";
}

function extractSlotTime(slot) {
  return slot.time ?? null;
}

async function attemptBooking(env, token, date, time) {
  const resourcesUrl = `${VAPI_BASE}/clubs/${CLUB_ID}/activity/${ACTIVITY_ID}/resources?date=${date}&time=${time}`;
  let resourcesRes;
  try {
    resourcesRes = await fetch(resourcesUrl, { headers: authHeaders(token) });
  } catch (err) {
    return { success: false, reason: `Resources fetch failed: ${err.message}` };
  }

  if (!resourcesRes.ok) return { success: false, reason: `Resources API error: ${resourcesRes.status}` };

  const data = await resourcesRes.json();
  const courts = Array.isArray(data) ? data : (data.resources ?? data.data ?? []);
  if (courts.length === 0) return { success: false, reason: "No courts available at that time" };

  const court = courts[0];
  // resourceKey comes back as {club, id} — the booking URL and body use just the numeric id
  const resourceKeyId = court.resourceKey?.id ?? court.resourceKey ?? court.id;
  const courtName = court.name ?? court.courtName ?? `Court ${resourceKeyId}`;

  const bookUrl = `${VAPI_BASE}/clubs/${CLUB_ID}/activity/${ACTIVITY_ID}/resources/${resourceKeyId}/bookings?date=${date}&time=${time}`;
  let bookRes;
  try {
    bookRes = await fetch(bookUrl, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ activityId: ACTIVITY_ID, resourceKey: resourceKeyId, date, startTime: time, duration: "60" }),
    });
  } catch (err) {
    return { success: false, reason: `Booking request failed: ${err.message}` };
  }

  if (!bookRes.ok) {
    const errBody = await bookRes.text().catch(() => "");
    return { success: false, reason: `Booking rejected: ${bookRes.status} — ${errBody.slice(0, 200)}` };
  }
  return { success: true, time, court: courtName };
}

// ── Availability helpers ──────────────────────────────────────────────────────

function findAvailableSlots(slots) {
  // slots are already filtered (isAvailable: true) and date-tagged by checkAvailability
  return Array.isArray(slots) ? slots : [];
}

function buildMessage(slots, controller, nextCheckTime) {
  const now = new Date(controller.scheduledTime);
  const next = new Date(nextCheckTime);
  const slotText =
    slots.length === 0
      ? "Currently no open slots"
      : `Currently open slots: ${slots.map((s) => `${s.date} at ${s.time}`).join(", ")}`;
  return `${fmt(now)}: checked for tennis court booking at Fulham Pools. ${slotText}. Check will run again at: ${fmt(next)}`;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getAuthToken(env) {
  const cached = await env.STATE.get("auth:token", { type: "json" });
  if (cached && cached.exp > Date.now() / 1000 + 60) return cached;

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...STATIC_HEADERS },
    body: JSON.stringify({ memberId: env.VA_USERNAME, password: env.VA_PASSWORD }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Login failed: ${res.status} — ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const authToken = data.token;

  // Decode exp from JWT payload without a library
  let exp;
  try {
    const payload = JSON.parse(atob(authToken.split(".")[1]));
    exp = payload.exp;
  } catch {
    exp = Date.now() / 1000 + 3600;
  }

  // Fetch member to get loyalty token
  let loyaltyToken;
  try {
    const memberRes = await fetch(`${VAPI_BASE}/member`, {
      headers: { ...STATIC_HEADERS, "x-auth-token": authToken },
    });
    if (memberRes.ok) {
      const member = await memberRes.json();
      loyaltyToken = member.loyalty ?? null;
    }
  } catch {
    // loyalty is optional — API calls still work without it
  }

  const token = { authToken, loyaltyToken, exp };
  await env.STATE.put("auth:token", JSON.stringify(token), { expirationTtl: 3600 });
  return token;
}

function authHeaders(token) {
  return {
    ...STATIC_HEADERS,
    "x-auth-token": token.authToken,
    ...(token.loyaltyToken ? { "x-loyalty": token.loyaltyToken } : {}),
  };
}

// ── Notify ────────────────────────────────────────────────────────────────────

async function notify(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_GRPCHAT_ID) {
    console.log(message);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_GRPCHAT_ID, text: message }),
  });
  if (!res.ok) console.error(`Telegram notify failed: ${res.status}`);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function fmt(d) {
  return d.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
