// /api/ical.js - 讀取 iCal 網址並解析成 JSON 事件
// GET /api/ical?url=<iCal URL>

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "缺少 url 參數" });
  
  // 安全檢查:只允許 http(s)
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

function parseICal(text) {
  // 展開多行(iCal 用 CRLF + 空格 續行)
  text = text.replace(/\r?\n[ \t]/g, "");
  const lines = text.split(/\r?\n/);
  
  const events = [];
  let cur = null;
  
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
    } else if (line === "END:VEVENT") {
      if (cur && cur.start) events.push(cur);
      cur = null;
    } else if (cur) {
      // 分離 KEY (含 params) 與 VALUE
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const keyPart = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1);
      const key = keyPart.split(";")[0];
      
      if (key === "SUMMARY") cur.title = unescapeIcal(value);
      else if (key === "DESCRIPTION") cur.desc = unescapeIcal(value);
      else if (key === "LOCATION") cur.location = unescapeIcal(value);
      else if (key === "DTSTART") cur.start = parseIcalDate(keyPart, value);
      else if (key === "DTEND") cur.end = parseIcalDate(keyPart, value, true);
      else if (key === "UID") cur.uid = value;
    }
  }
  
  return events;
}

function unescapeIcal(v) {
  return v.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseIcalDate(keyPart, value, isEnd) {
  // 全天事件:VALUE=DATE 20260702
  // 時間事件:20260702T150000Z 或 20260702T150000
  const isDate = /VALUE=DATE/.test(keyPart) || !/T/.test(value);
  
  if (isDate) {
    // YYYYMMDD
    const y = value.slice(0, 4), m = value.slice(4, 6), d = value.slice(6, 8);
    // 全天結束在 iCal 是「隔天 00:00」(exclusive),要 -1
    if (isEnd) {
      const dt = new Date(+y, +m - 1, +d);
      dt.setDate(dt.getDate() - 1);
      return dt.toISOString().slice(0, 10);
    }
    return y + "-" + m + "-" + d;
  }
  
  // 時間事件 → 轉 ISO
  const y = value.slice(0, 4), m = value.slice(4, 6), d = value.slice(6, 8);
  const H = value.slice(9, 11), M = value.slice(11, 13), S = value.slice(13, 15);
  if (value.endsWith("Z")) {
    return `${y}-${m}-${d}T${H}:${M}:${S}Z`;
  }
  return `${y}-${m}-${d}T${H}:${M}:${S}`;
}
