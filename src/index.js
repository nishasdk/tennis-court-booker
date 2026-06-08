const CLUB_ID = "47";
const ACTIVITY_ID = 41601;
const VAPI_BASE = "https://vapi.virginactive.com/vapi/2.0.1";

const AUTH_URL = `${VAPI_BASE}/sessions`;

const WINDOW_START = 7 * 60 + 30; // 07:30 in minutes
const WINDOW_END = 20 * 60 + 30;  // 20:30 in minutes
const BOOKING_RELEASE_END = 7 * 60 + 35; // always run within 07:30–07:35 regardless of random timer

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const PERIOD_PRESETS = {
  morning:   [["07:00", "09:00"], ["08:00", "10:00"], ["09:00", "11:00"]],
  afternoon: [["12:00", "14:00"], ["13:00", "15:00"], ["14:00", "16:00"]],
  evening:   [["17:00", "19:00"], ["18:00", "20:00"], ["19:00", "21:00"]],
};

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

    if (url.pathname === `/setup/${env.TELEGRAM_BOT_TOKEN}`) {
      const commands = [
        { command: "scan",      description: "Check availability right now" },
        { command: "bookslot",  description: "Pick a date and slot to book manually" },
        { command: "bookings",  description: "Manage auto-booking preferences" },
        { command: "slots",     description: "View current auto-booking preferences" },
        { command: "log",       description: "History of checks that found slots" },
        { command: "last",      description: "When was the last check" },
        { command: "next",      description: "When is the next check" },
        { command: "help",      description: "List all commands" },
      ];
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands }),
      });
      const result = await res.json();
      return new Response(JSON.stringify(result), { status: res.status, headers: { "content-type": "application/json" } });
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

  // Check if we're waiting for a custom time input
  const convoRaw = await env.STATE.get(`convo:${chatId}`);
  if (convoRaw && !cmd.startsWith("/")) {
    const convo = JSON.parse(convoRaw);
    if (convo.step === "awaiting_period_custom_time") {
      const match = text.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
      if (!match) {
        await sendMessage(env, chatId, "Couldn't parse that. Enter a range like 14:00-16:00");
        return;
      }
      const [, from, to] = match;
      await advancePeriodTime(env, chatId, convo, from, to);
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

  if (cmd.startsWith("/bookings")) {
    const args = text.slice(cmd.length).trim();

    if (args === "cancel") {
      await env.STATE.delete("booking-pref");
      await env.STATE.delete(`convo:${chatId}`);
      await sendMessage(env, chatId, "All booking preferences cleared.");
      return;
    }

    const prefs = normPrefs(await env.STATE.get("booking-pref", { type: "json" }));
    const menuText = prefs.length
      ? `Auto-booking preferences:\n\n${formatPrefs(prefs)}\n\nWhat would you like to do?`
      : "No auto-booking preferences set yet.\n\nWhat would you like to do?";
    const res = await sendMessageWithKeyboard(env, chatId, menuText, buildBookMenuKeyboard());
    const msgId = res?.result?.message_id;
    await env.STATE.put(`convo:${chatId}`, JSON.stringify({ step: "book_menu", messageId: msgId }), { expirationTtl: 1800 });
    return;
  }

  if (cmd === "/slots") {
    const prefs = normPrefs(await env.STATE.get("booking-pref", { type: "json" }));
    if (prefs.length === 0) {
      await sendMessage(env, chatId, "No preferences set yet. Use /bookings to set some.");
      return;
    }
    const allDays = [...DAY_NAMES.slice(1), DAY_NAMES[0]];
    const lines = prefs.map((p, i) => {
      const anyDay = !p.days?.length;
      const dayLines = allDays.map((d) => `${anyDay || p.days.includes(d) ? "✅" : "◻️"}  ${d}`);
      return `Preference ${i + 1} — ⏰ ${p.from}–${p.to}\n${dayLines.join("\n")}`;
    });
    await sendMessage(env, chatId, `Auto-booking preferences:\n\n${lines.join("\n\n")}`);
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

  if (cmd === "/scan") {
    const sent = await sendMessage(env, chatId, "⏳ Scanning...");
    const msgId = sent?.result?.message_id;
    let token;
    try {
      token = await getAuthToken(env);
    } catch (err) {
      await editMessageText(env, chatId, msgId, `⚠️ Auth failed: ${err.message}`);
      return;
    }
    const slots = [];
    for (let i = 0; i <= 7; i++) {
      const date = toDateString(Date.now() + i * 24 * 60 * 60 * 1000);
      try {
        const res = await fetch(`${VAPI_BASE}/clubs/${CLUB_ID}/activity/${ACTIVITY_ID}?date=${date}`, { headers: authHeaders(token) });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) data.filter((s) => s.isAvailable).forEach((s) => slots.push({ ...s, date }));
        }
      } catch { /* skip */ }
    }
    if (slots.length === 0) {
      await editMessageText(env, chatId, msgId, "No available slots found right now.");
      return;
    }
    const text = `Found ${slots.length} slot${slots.length > 1 ? "s" : ""}:\n${slots.map((s) => `• ${fmtSlotDate(s.date)} at ${s.time}`).join("\n")}`;
    const keyboard = {
      inline_keyboard: slots.slice(0, 5).map((s) => ([{
        text: `📅 Book ${fmtSlotDate(s.date)} at ${s.time}`,
        callback_data: `quickbook:${s.date}|${s.time}|${s.resourceKey?.id ?? ""}`,
      }])),
    };
    await editMessageText(env, chatId, msgId, text, keyboard);
    return;
  }

  if (cmd === "/bookslot") {
    const sent = await sendMessage(env, chatId, "Which date?", buildDateKeyboard());
    const msgId = sent?.result?.message_id;
    await env.STATE.put(`convo:${chatId}`, JSON.stringify({ step: "bookslot_date", messageId: msgId }), { expirationTtl: 1800 });
    return;
  }

  if (cmd === "/help") {
    await sendMessage(
      env,
      chatId,
      "/scan — check availability right now\n/bookslot — manually pick a date and slot to book\n/bookings — set up auto-booking preferences\n/slots — view current preferences\n/log — history of checks that found slots\n/last — when was the last check\n/next — when is the next check",
    );
  }
}

async function handleCallbackQuery(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const convoKey = `convo:${chatId}`;

  await answerCallbackQuery(env, query.id);

  const convoRaw = await env.STATE.get(convoKey);
  const convo = convoRaw ? JSON.parse(convoRaw) : null;

  // ── Book menu ──
  if (data === "book:add") {
    const newConvo = { step: "period_select", selectedPeriods: [], messageId };
    await env.STATE.put(convoKey, JSON.stringify(newConvo), { expirationTtl: 1800 });
    await editMessageText(env, chatId, messageId, "When would you like to play? (select all that apply)", buildPeriodKeyboard([]));
    return;
  }

  if (data === "book:remove") {
    const prefs = normPrefs(await env.STATE.get("booking-pref", { type: "json" }));
    await env.STATE.put(convoKey, JSON.stringify({ step: "remove_select", messageId }), { expirationTtl: 1800 });
    await editMessageText(env, chatId, messageId, "Which slot would you like to remove?", buildRemoveKeyboard(prefs));
    return;
  }

  // ── Period selection ──
  if (data.startsWith("period:") && data !== "period:confirm") {
    if (!convo || convo.step !== "period_select") return;
    const period = data.slice(7);
    convo.selectedPeriods = convo.selectedPeriods.includes(period)
      ? convo.selectedPeriods.filter((p) => p !== period)
      : [...convo.selectedPeriods, period];
    await env.STATE.put(convoKey, JSON.stringify(convo), { expirationTtl: 1800 });
    await editMessageReplyMarkup(env, chatId, messageId, buildPeriodKeyboard(convo.selectedPeriods));
    return;
  }

  if (data === "period:confirm") {
    if (!convo || !convo.selectedPeriods?.length) {
      await answerCallbackQuery(env, query.id, "Select at least one period first.");
      return;
    }
    const [current, ...pending] = convo.selectedPeriods;
    const newConvo = { step: "time_for_period", currentPeriod: current, pendingPeriods: pending, newSlots: [], messageId };
    await env.STATE.put(convoKey, JSON.stringify(newConvo), { expirationTtl: 1800 });
    await editMessageText(env, chatId, messageId, `Preferred time for ${capitalise(current)}?`, buildPeriodTimeKeyboard(current));
    return;
  }

  // ── Per-period time selection ──
  if (data === "ptime:custom") {
    if (!convo || convo.step !== "time_for_period") return;
    convo.step = "awaiting_period_custom_time";
    await env.STATE.put(convoKey, JSON.stringify(convo), { expirationTtl: 1800 });
    await editMessageText(env, chatId, messageId, `Enter your ${capitalise(convo.currentPeriod)} time range, e.g. 14:00-16:00`);
    return;
  }

  if (data.startsWith("ptime:")) {
    if (!convo || convo.step !== "time_for_period") return;
    const [from, to] = data.slice(6).split("-");
    await advancePeriodTime(env, chatId, convo, from, to);
    return;
  }

  // ── Day toggled ──
  if (data.startsWith("day:")) {
    if (!convo) { await sendMessage(env, chatId, "Session expired — send /bookings to start again."); return; }
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

  // ── Confirm days → save ──
  if (data === "days:confirm") {
    if (!convo) { await sendMessage(env, chatId, "Session expired — send /bookings to start again."); return; }
    const existingPrefs = normPrefs(await env.STATE.get("booking-pref", { type: "json" }));
    const newEntries = convo.newSlots.map((s) => ({ from: s.from, to: s.to, days: convo.days }));
    const overlaps = findOverlaps(newEntries, existingPrefs);
    const updated = [...existingPrefs, ...newEntries];
    await env.STATE.put("booking-pref", JSON.stringify(updated));
    await env.STATE.delete(convoKey);
    const daysText = convo.days.length ? convo.days.join(", ") : "any day";
    const addedText = newEntries.map((e) => `• ${e.from}–${e.to}`).join("\n");
    const overlapNote = overlaps.length ? `\n\n⚠️ Overlap with existing: ${overlaps.join("; ")}` : "";
    await editMessageText(env, chatId, messageId, `✅ Added:\n${addedText}\non ${daysText}${overlapNote}\n\nAll preferences:\n${formatPrefs(updated)}`);
    return;
  }

  // ── Remove a slot ──
  if (data.startsWith("remove:")) {
    const idx = parseInt(data.slice(7));
    const prefs = normPrefs(await env.STATE.get("booking-pref", { type: "json" }));
    const updated = prefs.filter((_, i) => i !== idx);
    if (updated.length) {
      await env.STATE.put("booking-pref", JSON.stringify(updated));
    } else {
      await env.STATE.delete("booking-pref");
    }
    await env.STATE.delete(convoKey);
    const msg = updated.length ? `✅ Removed. Remaining:\n\n${formatPrefs(updated)}` : "✅ Removed. No preferences remaining.";
    await editMessageText(env, chatId, messageId, msg);
    return;
  }

  // ── /bookslot date → time → book ──
  if (data.startsWith("bsdate:")) {
    const date = data.slice(7);
    await editMessageText(env, chatId, messageId, `⏳ Fetching slots for ${fmtSlotDate(date)}...`);
    let token;
    try { token = await getAuthToken(env); } catch (err) {
      await editMessageText(env, chatId, messageId, `⚠️ Auth failed: ${err.message}`);
      return;
    }
    const res = await fetch(`${VAPI_BASE}/clubs/${CLUB_ID}/activity/${ACTIVITY_ID}?date=${date}`, { headers: authHeaders(token) });
    if (!res.ok) { await editMessageText(env, chatId, messageId, `⚠️ API error: ${res.status}`); return; }
    const data2 = await res.json();
    const available = Array.isArray(data2) ? data2.filter((s) => s.isAvailable) : [];
    if (!available.length) { await editMessageText(env, chatId, messageId, `No available slots on ${fmtSlotDate(date)}.`); return; }
    const keyboard = {
      inline_keyboard: available.map((s) => ([{ text: s.time, callback_data: `bstime:${date}|${s.time}|${s.resourceKey?.id ?? ""}` }])),
    };
    await env.STATE.put(`convo:${chatId}`, JSON.stringify({ step: "bookslot_time", date, messageId }), { expirationTtl: 1800 });
    await editMessageText(env, chatId, messageId, `Available on ${fmtSlotDate(date)} — tap to book:`, keyboard);
    return;
  }

  if (data.startsWith("bstime:")) {
    const [date, time, rkId] = data.slice(7).split("|");
    await editMessageText(env, chatId, messageId, `⏳ Booking ${fmtSlotDate(date)} at ${time}...`);
    let token;
    try { token = await getAuthToken(env); } catch (err) {
      await editMessageText(env, chatId, messageId, `⚠️ Auth failed: ${err.message}`);
      return;
    }
    const result = await attemptBooking(env, token, date, time, rkId || null);
    await env.STATE.delete(`convo:${chatId}`);
    if (result.success) {
      await editMessageText(env, chatId, messageId, `✅ Court booked!\n📅 ${fmtSlotDate(date)} at ${result.time}\n🎾 ${result.court}\n📆 [Add to Google Calendar](${calendarLink(date, result.time, result.court)})`, null, { parse_mode: "Markdown" });
    } else {
      await editMessageText(env, chatId, messageId, `❌ Booking failed: ${result.reason}`);
    }
    return;
  }

  // ── Quick-book from notification ──
  if (data.startsWith("quickbook:")) {
    const [date, time, rkId] = data.slice(10).split("|");
    await editMessageText(env, chatId, messageId, `⏳ Booking ${fmtSlotDate(date)} at ${time}...`);
    let token;
    try {
      token = await getAuthToken(env);
    } catch (err) {
      await editMessageText(env, chatId, messageId, `⚠️ Auth failed: ${err.message}`);
      return;
    }
    const result = await attemptBooking(env, token, date, time, rkId || null);
    if (result.success) {
      await editMessageText(env, chatId, messageId, `✅ Court booked!\n📅 ${fmtSlotDate(date)} at ${result.time}\n🎾 ${result.court}\n📆 [Add to Google Calendar](${calendarLink(date, result.time, result.court)})`, null, { parse_mode: "Markdown" });
    } else {
      await editMessageText(env, chatId, messageId, `❌ Booking failed: ${result.reason}`);
    }
    return;
  }

  if (data === "remove:cancel") {
    await env.STATE.delete(convoKey);
    const prefs = normPrefs(await env.STATE.get("booking-pref", { type: "json" }));
    await editMessageText(env, chatId, messageId, `Cancelled.\n\nCurrent preferences:\n\n${formatPrefs(prefs)}`);
    return;
  }
}

async function advancePeriodTime(env, chatId, convo, from, to) {
  const convoKey = `convo:${chatId}`;
  const newSlots = [...(convo.newSlots ?? []), { from, to }];
  if (convo.pendingPeriods?.length) {
    const [next, ...rest] = convo.pendingPeriods;
    const updated = { ...convo, step: "time_for_period", currentPeriod: next, pendingPeriods: rest, newSlots };
    await env.STATE.put(convoKey, JSON.stringify(updated), { expirationTtl: 1800 });
    await editMessageText(env, chatId, convo.messageId, `Preferred time for ${capitalise(next)}?`, buildPeriodTimeKeyboard(next));
  } else {
    const updated = { ...convo, step: "day_select", newSlots, days: [] };
    await env.STATE.put(convoKey, JSON.stringify(updated), { expirationTtl: 1800 });
    const summary = newSlots.map((s) => `• ${s.from}–${s.to}`).join("\n");
    await editMessageText(env, chatId, convo.messageId, `Adding:\n${summary}\n\nWhich days?`, buildDayKeyboard([]));
  }
}

// ── Keyboard builders ─────────────────────────────────────────────────────────

function buildDateKeyboard() {
  const days = [];
  for (let i = 0; i <= 7; i++) {
    const ms = Date.now() + i * 24 * 60 * 60 * 1000;
    const date = toDateString(ms);
    days.push({ text: fmtSlotDate(date), callback_data: `bsdate:${date}` });
  }
  // Two per row
  const rows = [];
  for (let i = 0; i < days.length; i += 2) rows.push(days.slice(i, i + 2));
  return { inline_keyboard: rows };
}

function buildBookMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ Add slot", callback_data: "book:add" }],
      [{ text: "🗑 Remove a slot", callback_data: "book:remove" }],
    ],
  };
}

function buildPeriodKeyboard(selected) {
  const periods = ["morning", "afternoon", "evening"];
  const labels = { morning: "🌅 Morning", afternoon: "☀️ Afternoon", evening: "🌆 Evening" };
  return {
    inline_keyboard: [
      periods.map((p) => ({
        text: selected.includes(p) ? `✅ ${labels[p]}` : labels[p],
        callback_data: `period:${p}`,
      })),
      [{ text: "Confirm ✓", callback_data: "period:confirm" }],
    ],
  };
}

function buildPeriodTimeKeyboard(period) {
  const presets = PERIOD_PRESETS[period] ?? [];
  return {
    inline_keyboard: [
      presets.map(([from, to]) => ({ text: `${from}–${to}`, callback_data: `ptime:${from}-${to}` })),
      [{ text: "✏️ Custom", callback_data: "ptime:custom" }],
    ],
  };
}

function buildRemoveKeyboard(prefs) {
  return {
    inline_keyboard: [
      ...prefs.map((p, i) => {
        const days = p.days?.length ? p.days.join(", ") : "any day";
        return [{ text: `🗑 ${p.from}–${p.to} on ${days}`, callback_data: `remove:${i}` }];
      }),
      [{ text: "Cancel", callback_data: "remove:cancel" }],
    ],
  };
}

function buildDayKeyboard(selected) {
  const anyDay = selected.length === 0;
  // Mon–Sat then Sun on its own row
  const weekdays = [...DAY_NAMES.slice(1), DAY_NAMES[0]];

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

async function sendMessage(env, chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}


async function sendMessageWithKeyboard(env, chatId, text, replyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
  });
  return res.json();
}

async function editMessageText(env, chatId, messageId, text, replyMarkup = null, extra = {}) {
  const body = { chat_id: chatId, message_id: messageId, text, ...extra };
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

function londonParts(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
}

function londonMinutes(date) {
  const parts = londonParts(date);
  const h = parseInt(parts.find((p) => p.type === "hour").value);
  const m = parseInt(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}

function londonHour(date) {
  const parts = londonParts(date);
  return parseInt(parts.find((p) => p.type === "hour").value);
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

  // If booking preferences are set, try to book the first matching slot
  const prefs = normPrefs(await env.STATE.get("booking-pref", { type: "json" }));
  if (prefs.length > 0 && slots.length > 0) {
    const match = slots.find((s) => slotMatchesPref(s, prefs));
    if (match) {
      const bookDate = match.date;
      const bookTime = match.time;
      const result = await attemptBooking(env, token, bookDate, bookTime, match.resourceKey?.id ?? null);
      if (result.success) {
        await notify(env, `✅ Court booked!\n📅 ${fmtSlotDate(bookDate)} at ${result.time}\n🎾 ${result.court}\n📆 [Add to Google Calendar](${calendarLink(result.date ?? bookDate, result.time, result.court)})`, null, { parse_mode: "Markdown" });
      } else {
        if (!await env.STATE.get("book-error-notified")) {
          await env.STATE.put("book-error-notified", "1");
          await notify(env, `⚠️ Slot found (${bookDate} at ${bookTime}) but booking failed: ${result.reason}`);
        }
      }
    }
  }
  await env.STATE.delete("book-error-notified");

  // Log any seen slots
  if (slots.length > 0) {
    await appendSlotLog(env, now, slots, prefs);
  }

  // Notify immediately if slots found (with Book buttons); otherwise only at 08:00, 12:00, 20:00 London time
  if (slots.length > 0) {
    await notifyWithBookButtons(env, slots, controller, nextCheckTime);
  } else {
    const hour = londonHour(new Date(now));
    const today = toDateString(now);
    const windows = [{ h: 8, key: "notified:8" }, { h: 12, key: "notified:12" }, { h: 20, key: "notified:20" }];
    for (const { h, key } of windows) {
      if (hour >= h && hour < h + 1) {
        const sent = await env.STATE.get(key);
        if (sent !== today) {
          await env.STATE.put(key, today);
          await notify(env, buildMessage(slots, controller, nextCheckTime));
        }
        break;
      }
    }
  }

  await env.STATE.put("last-run", new Date(now).toISOString());
}

async function appendSlotLog(env, now, slots, prefs) {
  const existing = await env.STATE.get("slot-log", { type: "json" }) ?? [];
  const matched = slots.filter((s) => slotMatchesPref(s, prefs)).map((s) => `${s.date} ${s.time}`);
  const prefText = prefs.length ? prefs.map((p) => `${p.from}–${p.to}`).join(", ") : null;
  const entry = {
    at: new Date(now).toISOString(),
    slots: slots.map((s) => `${s.date} ${s.time}`),
    pref: prefText,
    matched,
  };
  const updated = [entry, ...existing].slice(0, 30);
  await env.STATE.put("slot-log", JSON.stringify(updated));
}

// ── Booking ───────────────────────────────────────────────────────────────────


function slotMatchesPref(slot, prefs) {
  return normPrefs(prefs).some((p) => slotMatchesSingle(slot, p));
}

function slotMatchesSingle(slot, pref) {
  const time = extractSlotTime(slot);
  if (!time) return false;
  const slotMins = timeToMins(time);
  if (slotMins < timeToMins(pref.from) || slotMins >= timeToMins(pref.to)) return false;
  if (pref.days?.length > 0) {
    const date = extractSlotDate(slot);
    if (!date) return false;
    const dayName = DAY_NAMES[new Date(date + "T12:00:00Z").getUTCDay()];
    if (!pref.days.includes(dayName)) return false;
  }
  return true;
}

function normPrefs(raw) {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function timeToMins(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function findOverlaps(newEntries, existing) {
  const overlaps = [];
  for (const n of newEntries) {
    for (const e of existing) {
      const daysClash = !n.days.length || !e.days?.length || n.days.some((d) => e.days.includes(d));
      const timeClash = timeToMins(n.from) < timeToMins(e.to) && timeToMins(e.from) < timeToMins(n.to);
      if (daysClash && timeClash) overlaps.push(`${n.from}–${n.to} overlaps with ${e.from}–${e.to}`);
    }
  }
  return overlaps;
}

function formatPrefs(prefs) {
  if (!prefs.length) return "None.";
  return prefs.map((p, i) => {
    const days = p.days?.length ? p.days.join(", ") : "any day";
    return `${i + 1}. ${p.from}–${p.to} on ${days}`;
  }).join("\n");
}

function extractSlotDate(slot) {
  return slot.date ?? "";
}

function extractSlotTime(slot) {
  return slot.time ?? null;
}

const COURT_NAMES = { 201: "Court 1", 202: "Court 2", 203: "Court 3" };

async function attemptBooking(env, token, date, time, resourceKeyId = null) {
  let courtName = COURT_NAMES[resourceKeyId] ?? `Court ${resourceKeyId}`;

  if (!resourceKeyId) {
    // Fall back to resources lookup if we don't already know the court
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
    resourceKeyId = court.resourceKey?.id ?? court.resourceKey ?? court.id;
    courtName = COURT_NAMES[resourceKeyId] ?? court.name ?? `Court ${resourceKeyId}`;
  }

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
  return { success: true, time, court: courtName, date };
}

function calendarLink(date, time, court) {
  const [h, m] = time.split(":").map(Number);
  const pad = n => String(n).padStart(2, "0");
  const fmt = (y, mo, d, hh, mm) => `${y}${pad(mo)}${pad(d)}T${pad(hh)}${pad(mm)}00`;
  const [y, mo, d] = date.split("-").map(Number);
  const start = fmt(y, mo, d, h, m);
  const end = fmt(y, mo, d, h + 1, m);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `Tennis — ${court}`,
    dates: `${start}/${end}`,
    details: `Booked via Virgin Active Fulham Pools`,
    location: "Virgin Active Fulham Pools, Fulham, London",
  });
  return `https://calendar.google.com/calendar/render?${params}`;
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
      : `Open slots:\n${slots.map((s) => `• ${fmtSlotDate(s.date)} at ${s.time}`).join("\n")}`;
  return `${fmt(now)}: checked Fulham Pools. ${slotText}\n\nNext check: ${fmt(next)}`;
}

function fmtSlotDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

async function notifyWithBookButtons(env, slots, controller, nextCheckTime) {
  const text = buildMessage(slots, controller, nextCheckTime);
  // Show a Book button for each slot (max 5 to keep keyboard manageable)
  const keyboard = {
    inline_keyboard: slots.slice(0, 5).map((s) => ([{
      text: `📅 Book ${fmtSlotDate(s.date)} at ${s.time}`,
      callback_data: `quickbook:${s.date}|${s.time}|${s.resourceKey?.id ?? ""}`,
    }])),
  };
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_GRPCHAT_ID) { console.log(text); return; }
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_GRPCHAT_ID, text, reply_markup: keyboard }),
  });
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

async function notify(env, message, extra = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_GRPCHAT_ID) {
    console.log(message);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_GRPCHAT_ID, text: message, ...extra }),
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
