// /api/ical.js - 讀取 iCal 網址並解析成 JSON 事件（支援 RRULE 展開）
// GET /api/ical?url=<iCal URL>

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "缺少 url 參數" });
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "無效的網址" });

  try {
    const r = await fetch(url, { headers: { "User-Agent": "finn-editor/1.0" } });
    if (!r.ok) return res.status(500).json({ error: "iCal 取得失敗:HTTP " + r.status });
    const text = await r.text();
    const events = parseICal(text);
    return res.status(200).json({ events });
  } catch (e) {
    console.error("iCal fetch error:", e);
    return res.status(500).json({ error: String(e) });
  }
}

// 展開範圍：今天前後 6 個月
const RANGE_START = (() => { const d = new Date(); d.setMonth(d.getMonth() - 2); d.setHours(0,0,0,0); return d; })();
const RANGE_END   = (() => { const d = new Date(); d.setMonth(d.getMonth() + 6); d.setHours(0,0,0,0); return d; })();

function parseICal(text) {
  text = text.replace(/\r?\n[ \t]/g, "");
  const lines = text.split(/\r?\n/);

  const rawEvents = [];
  let cur = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
    } else if (line === "END:VEVENT") {
      if (cur && cur.start) rawEvents.push(cur);
      cur = null;
    } else if (cur) {
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const keyPart = line.slice(0, colonIdx);
      const value   = line.slice(colonIdx + 1);
      const key     = keyPart.split(";")[0];

      if      (key === "SUMMARY")     cur.title    = unescapeIcal(value);
      else if (key === "DESCRIPTION") cur.desc     = unescapeIcal(value);
      else if (key === "LOCATION")    cur.location = unescapeIcal(value);
      else if (key === "DTSTART")     { cur.start = parseIcalDate(keyPart, value); cur._startRaw = value; cur._startKeyPart = keyPart; }
      else if (key === "DTEND")       { cur.end   = parseIcalDate(keyPart, value, true); cur._endRaw = value; cur._endKeyPart = keyPart; }
      else if (key === "UID")         cur.uid      = value;
      else if (key === "RRULE")       cur.rrule    = value;
      else if (key === "EXDATE")      {
        // 排除日期（可能多個，逗號分隔）
        cur.exdates = cur.exdates || [];
        value.split(",").forEach(v => cur.exdates.push(v.slice(0, 8))); // 只取 YYYYMMDD
      }
    }
  }

  const result = [];
  for (const ev of rawEvents) {
    if (!ev.rrule) {
      // 單次事件，直接加入
      result.push(makeEvent(ev, ev.start, ev.end));
    } else {
      // 展開重複事件
      const expanded = expandRRule(ev);
      result.push(...expanded);
    }
  }

  return result;
}

function makeEvent(ev, start, end) {
  return {
    title:    ev.title    || "",
    desc:     ev.desc     || "",
    location: ev.location || "",
    start,
    end,
    uid:      ev.uid      || "",
  };
}

function expandRRule(ev) {
  const rule = parseRRule(ev.rrule);
  if (!rule) return [makeEvent(ev, ev.start, ev.end)];

  const exdates = new Set(ev.exdates || []);
  const results = [];

  // 計算事件持續時間（毫秒）
  const startDt = parseToDate(ev.start);
  const endDt   = ev.end ? parseToDate(ev.end) : null;
  const duration = endDt ? endDt - startDt : 0;

  // UNTIL or COUNT
  let until = rule.until ? new Date(rule.until) : null;
  const count = rule.count || 500; // 最多展開 500 次

  const freq = rule.freq; // WEEKLY, DAILY, MONTHLY, YEARLY
  const interval = rule.interval || 1;
  const byday = rule.byday; // e.g. ["MO","TU"]

  let current = new Date(startDt);
  let n = 0;

  // 限制展開範圍避免無限迴圈
  const hardStop = new Date(Math.min(
    RANGE_END.getTime(),
    until ? until.getTime() : Infinity
  ));

  while (current <= hardStop && n < count) {
    const dateStr8 = toYMD8(current);

    if (!exdates.has(dateStr8) && current >= RANGE_START) {
      const startIso = toIso(current, ev.start);
      const endIso   = duration ? toIso(new Date(current.getTime() + duration), ev.end || ev.start) : null;
      results.push(makeEvent(ev, startIso, endIso));
    }
    n++;

    // 推進到下一個發生點
    if (freq === "DAILY") {
      current = addDays(current, interval);
    } else if (freq === "WEEKLY") {
      if (byday && byday.length > 1) {
        // 多天（例如每週一三五）：找本週剩餘天，再跳下週
        current = nextByDay(current, byday, interval);
      } else {
        current = addDays(current, 7 * interval);
      }
    } else if (freq === "MONTHLY") {
      current = addMonths(current, interval);
    } else if (freq === "YEARLY") {
      current = addMonths(current, 12 * interval);
    } else {
      break; // 不支援的 FREQ
    }
  }

  return results;
}

function parseRRule(rrule) {
  if (!rrule) return null;
  const parts = {};
  for (const part of rrule.split(";")) {
    const [k, v] = part.split("=");
    parts[k] = v;
  }
  if (!parts.FREQ) return null;

  return {
    freq:     parts.FREQ,
    interval: parts.INTERVAL ? parseInt(parts.INTERVAL) : 1,
    count:    parts.COUNT    ? parseInt(parts.COUNT)    : null,
    until:    parts.UNTIL    ? parseUntil(parts.UNTIL)  : null,
    byday:    parts.BYDAY    ? parts.BYDAY.split(",").map(d => d.replace(/^[+-]?\d+/, "")) : null,
  };
}

function parseUntil(v) {
  // UNTIL=20261231T000000Z or 20261231
  const y = v.slice(0,4), m = v.slice(4,6), d = v.slice(6,8);
  return `${y}-${m}-${d}`;
}

// 找 byday 中下一個符合的日期
const WEEKDAYS = ["SU","MO","TU","WE","TH","FR","SA"];
function nextByDay(current, byday, interval) {
  const cur = new Date(current);
  const targetDows = byday.map(d => WEEKDAYS.indexOf(d)).filter(d => d >= 0).sort((a,b) => a-b);
  const curDow = cur.getDay();

  // 找本週還有沒有更晚的目標日
  const next = targetDows.find(d => d > curDow);
  if (next !== undefined) {
    return addDays(cur, next - curDow);
  }
  // 跳到下一個 interval 週的第一個目標日
  const daysToNextWeekFirst = (7 * interval) - curDow + targetDows[0];
  return addDays(cur, daysToNextWeekFirst);
}

function addDays(dt, n) {
  const d = new Date(dt);
  d.setDate(d.getDate() + n);
  return d;
}

function addMonths(dt, n) {
  const d = new Date(dt);
  d.setMonth(d.getMonth() + n);
  return d;
}

function parseToDate(iso) {
  // iso: "2026-07-14" or "2026-07-14T10:00:00Z" or "2026-07-14T10:00:00"
  return new Date(iso.includes("T") ? iso : iso + "T00:00:00");
}

function toYMD8(dt) {
  return dt.getFullYear().toString() +
    String(dt.getMonth()+1).padStart(2,"0") +
    String(dt.getDate()).padStart(2,"0");
}

function toIso(dt, refIso) {
  // 如果原始是全天事件（無 T），輸出 YYYY-MM-DD
  if (!refIso || !refIso.includes("T")) {
    return dt.getFullYear() + "-" +
      String(dt.getMonth()+1).padStart(2,"0") + "-" +
      String(dt.getDate()).padStart(2,"0");
  }
  // 有時間的：輸出 ISO with time
  const isUTC = refIso.endsWith("Z");
  const Y = dt.getFullYear();
  const M = String(dt.getMonth()+1).padStart(2,"0");
  const D = String(dt.getDate()).padStart(2,"0");
  const H = String(dt.getHours()).padStart(2,"0");
  const m = String(dt.getMinutes()).padStart(2,"0");
  const S = String(dt.getSeconds()).padStart(2,"0");
  return isUTC ? `${Y}-${M}-${D}T${H}:${m}:${S}Z` : `${Y}-${M}-${D}T${H}:${m}:${S}`;
}

function unescapeIcal(v) {
  return v.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseIcalDate(keyPart, value, isEnd) {
  const isDate = /VALUE=DATE/.test(keyPart) || !/T/.test(value);

  if (isDate) {
    const y = value.slice(0,4), m = value.slice(4,6), d = value.slice(6,8);
    if (isEnd) {
      const dt = new Date(+y, +m-1, +d);
      dt.setDate(dt.getDate() - 1);
      return dt.toISOString().slice(0,10);
    }
    return y + "-" + m + "-" + d;
  }

  const y = value.slice(0,4), m = value.slice(4,6), d = value.slice(6,8);
  const H = value.slice(9,11), M = value.slice(11,13), S = value.slice(13,15);
  return value.endsWith("Z")
    ? `${y}-${m}-${d}T${H}:${M}:${S}Z`
    : `${y}-${m}-${d}T${H}:${M}:${S}`;
}
