// api/notion.js - Vercel Serverless Function
const NOTION_API = "https://api.notion.com/v1";
const DB_ID = "9b73ebba-2aec-49ac-be96-4483360a1456";
const CLIENTS_DB_ID = "6c9acb62-8a9d-4da0-b139-7469a801789f";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const NOTION_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_KEY) {
    return res.status(500).json({ error: "Missing NOTION_API_KEY" });
  }

  const notionHeaders = {
    "Authorization": `Bearer ${NOTION_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  const action = req.query.action;
  const body = req.body;

  try {
    // ── Debug：看原始欄位名稱 ─────────────────────────────────────
    if (req.method === "GET" && action === "debug") {
      const response = await fetch(`${NOTION_API}/databases/${DB_ID}/query`, {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify({ page_size: 1 }),
      });
      const data = await response.json();
      if (data.results && data.results[0]) {
        const keys = Object.keys(data.results[0].properties);
        return res.status(200).json({ fields: keys, sample: data.results[0].properties });
      }
      return res.status(200).json({ error: "no data", raw: data });
    }

    // ── 讀取所有案子 ──────────────────────────────────────────────
    if (req.method === "GET" && (!action || action === "list")) {
      let results = [], cursor = undefined, hasMore = true;
      while (hasMore) {
        const payload = { page_size: 100 };
        if (cursor) payload.start_cursor = cursor;
        const response = await fetch(`${NOTION_API}/databases/${DB_ID}/query`, {
          method: "POST",
          headers: notionHeaders,
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (data.object === "error") {
          return res.status(500).json({ error: data.message });
        }
        results = results.concat(data.results || []);
        hasMore = data.has_more;
        cursor = data.next_cursor;
      }
      const projects = results.map(pageToProject).filter(Boolean);
      return res.status(200).json(projects);
    }

    // ── 新增案子 ──────────────────────────────────────────────────
    if (req.method === "POST" && action === "create") {
      const response = await fetch(`${NOTION_API}/pages`, {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify({
          parent: { database_id: DB_ID },
          properties: projectToProperties(body),
        }),
      });
      const data = await response.json();
      if (data.object === "error") {
        return res.status(500).json({ error: data.message });
      }
      return res.status(200).json(pageToProject(data));
    }

    // ── 更新案子 ──────────────────────────────────────────────────
    if (req.method === "PATCH" && action === "update") {
      const { notionId, ...project } = body;
      const response = await fetch(`${NOTION_API}/pages/${notionId}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ properties: projectToProperties(project) }),
      });
      const data = await response.json();
      if (data.object === "error") {
        return res.status(500).json({ error: data.message });
      }
      return res.status(200).json(pageToProject(data));
    }

    // ── 刪除案子（封存） ──────────────────────────────────────────
    if (req.method === "DELETE" && action === "delete") {
      const { notionId } = body;
      await fetch(`${NOTION_API}/pages/${notionId}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ archived: true }),
      });
      return res.status(200).json({ ok: true });
    }

    // ── 讀取客戶設定 ──────────────────────────────────────────────
    if (req.method === "GET" && action === "clients") {
      const response = await fetch(`${NOTION_API}/databases/${CLIENTS_DB_ID}/query`, {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify({ sorts: [{ property: "排序", direction: "ascending" }] }),
      });
      const data = await response.json();
      if (data.object === "error") return res.status(500).json({ error: data.message });
      const clients = (data.results || []).map(function(page) {
        const p = page.properties;
        return {
          notionId: page.id,
          name: p["客戶名稱"]?.title?.[0]?.plain_text || "",
          color: p["顏色"]?.rich_text?.[0]?.plain_text || "",
          order: p["排序"]?.number ?? 0,
        };
      }).filter(c => c.name);
      return res.status(200).json(clients);
    }

    // ── 儲存全部客戶設定（先刪再建）──────────────────────────────
    if (req.method === "POST" && action === "save-clients") {
      const { clients, colors } = body;
      // 先查所有現有客戶
      const listRes = await fetch(`${NOTION_API}/databases/${CLIENTS_DB_ID}/query`, {
        method: "POST", headers: notionHeaders, body: JSON.stringify({}),
      });
      const listData = await listRes.json();
      // 封存舊的
      await Promise.all((listData.results || []).map(page =>
        fetch(`${NOTION_API}/pages/${page.id}`, {
          method: "PATCH", headers: notionHeaders,
          body: JSON.stringify({ archived: true }),
        })
      ));
      // 新增新的
      await Promise.all((clients || []).map((name, i) =>
        fetch(`${NOTION_API}/pages`, {
          method: "POST", headers: notionHeaders,
          body: JSON.stringify({
            parent: { database_id: CLIENTS_DB_ID },
            properties: {
              "客戶名稱": { title: [{ text: { content: name } }] },
              "顏色": { rich_text: [{ text: { content: (colors && colors[name]) || "" } }] },
              "排序": { number: i },
            },
          }),
        })
      ));
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: "Not found" });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}

// ── Notion page → 你工具的 project 格式 ──────────────────────────
function pageToProject(page) {
  if (!page || !page.properties) return null;
  const p = page.properties;
  function txt(k) {
    try { return (p[k] && p[k].rich_text && p[k].rich_text[0]) ? p[k].rich_text[0].plain_text : (p[k] && p[k].title && p[k].title[0]) ? p[k].title[0].plain_text : ""; }
    catch(e) { return ""; }
  }
  function chk(k) { try { return !!(p[k] && p[k].checkbox); } catch(e) { return false; } }
  function sel(k) { try { return (p[k] && p[k].select) ? p[k].select.name : ""; } catch(e) { return ""; } }
  function dt(k)  { try { return (p[k] && p[k].date) ? p[k].date.start : ""; } catch(e) { return ""; } }
  function num(k) { try { return (p[k] && p[k].number !== null && p[k].number !== undefined) ? p[k].number : ""; } catch(e) { return ""; } }

  const pageId = page.id ? page.id.replace(/-/g, "") : "";

  return {
    id: pageId || Math.random().toString(36).slice(2, 9),
    notionId: page.id || "",
    name: txt("專案名稱"),
    client: txt("客戶"),
    airDate: txt("上片日期"),
    status: sel("進度"),
    type: sel("類型"),
    month: txt("工作月份"),
    order: sel("優先順序") || "-",
    length: txt("影片長度"),
    fee: num("收費"),
    costItems: [],
    taxCut: chk("扣稅10%"),
    feeItems: [],
    closed: chk("已結案"),
    note: txt("備註"),
    kanbanPos: num("看板位置") || null,
    editS: dt("剪輯開始"),
    editE: dt("剪輯結束"),
    cut1S: dt("初剪開始"),
    cut1E: dt("初剪結束"),
    cut1Due: dt("初剪交件日"),
    cut1Done: chk("初剪完成"),
    noCut1: chk("無初剪"),
    v1S: dt("ES開始"),
    v1E: dt("ES結束"),
    v1Due: dt("ES交件日"),
    v1Done: chk("ES完成"),
    bizS: dt("業配開始"),
    bizE: dt("業配結束"),
    bizDue: dt("業配交件日"),
    bizDone: chk("業配完成"),
    noBiz: chk("無業配"),
    finalDue: dt("Final截止日"),
    finalDone: chk("Final完成"),
  };
}

// ── 你工具的 project 格式 → Notion properties ────────────────────
function projectToProperties(p) {
  function richText(v) { return [{ text: { content: String(v || "") } }]; }
  function date(v) { return v ? { start: v } : null; }

  return {
    "專案名稱": { title: richText(p.name) },
    "客戶":      { rich_text: richText(p.client) },
    "上片日期":  { rich_text: richText(p.airDate || "") },
    "進度":      { select: p.status ? { name: p.status } : null },
    "類型":      { select: p.type ? { name: p.type } : null },
    "工作月份":  { rich_text: richText(p.month || "") },
    "優先順序":  { select: p.order && p.order !== "-" ? { name: p.order } : null },
    "影片長度":  { rich_text: richText(p.length || "") },
    "收費":      { number: Number(p.fee) || null },
    "支出":      { number: Number((p.costItems || []).reduce(function(s, x) { return s + (Number(x.amount) || 0); }, 0)) || null },
    "扣稅10%":   { checkbox: !!p.taxCut },
    "已結案":    { checkbox: !!p.closed },
    "備註":      { rich_text: richText(p.note || "") },
    "看板位置":  { number: p.kanbanPos !== null && p.kanbanPos !== undefined ? p.kanbanPos : null },
    "剪輯開始":  { date: date(p.editS) },
    "剪輯結束":  { date: date(p.editE) },
    "初剪開始":  { date: date(p.cut1S) },
    "初剪結束":  { date: date(p.cut1E) },
    "初剪交件日":{ date: date(p.cut1Due) },
    "初剪完成":  { checkbox: !!p.cut1Done },
    "無初剪":    { checkbox: !!p.noCut1 },
    "ES開始":    { date: date(p.v1S) },
    "ES結束":    { date: date(p.v1E) },
    "ES交件日":  { date: date(p.v1Due) },
    "ES完成":    { checkbox: !!p.v1Done },
    "業配開始":  { date: date(p.bizS) },
    "業配結束":  { date: date(p.bizE) },
    "業配交件日":{ date: date(p.bizDue) },
    "業配完成":  { checkbox: !!p.bizDone },
    "無業配":    { checkbox: !!p.noBiz },
    "Final截止日":{ date: date(p.finalDue) },
    "Final完成": { checkbox: !!p.finalDone },
  };
}
