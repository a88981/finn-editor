// 隨手記：讀取 Notion「小玩剪輯進度_DB」裡還沒完成的案子
// 部署位置：Vercel 專案的 api/worklog-progress.js
// 使用跟剪輯助理同一組 Notion integration（環境變數），不用另外設定
const DB_ID = '9b73ebba2aec49acbe964483360a1456';

const pick = (p) => {
  if (!p) return null;
  switch (p.type) {
    case 'title': return (p.title || []).map(t => t.plain_text).join('');
    case 'rich_text': return (p.rich_text || []).map(t => t.plain_text).join('');
    case 'select': return p.select ? p.select.name : null;
    case 'checkbox': return !!p.checkbox;
    case 'date': return p.date ? p.date.start : null;
    case 'number': return p.number;
    default: return null;
  }
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY || process.env.NOTION_KEY || process.env.NOTION_SECRET;
  if (!token) return res.status(500).json({ error: 'no_token' });

  const items = [];
  let cursor;
  try {
    do {
      const r = await fetch(`https://api.notion.com/v1/databases/${DB_ID}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_size: 100,
          start_cursor: cursor,
          filter: { and: [
            { property: 'Final完成', checkbox: { equals: false } },
            { property: '已結案', checkbox: { equals: false } },
          ] },
        }),
      });
      if (!r.ok) return res.status(r.status).json({ error: 'notion', detail: await r.text() });
      const j = await r.json();
      for (const page of j.results) {
        const P = page.properties || {};
        const g = (k) => pick(P[k]);
        items.push({
          id: page.id,
          url: page.url,
          name: g('專案名稱') || '(未命名)',
          client: g('客戶') || '',
          stage: g('進度') || '',
          priority: g('優先順序') || '',
          type: g('類型') || '',
          note: g('備註') || '',
          upload: g('上片日期'),
          steps: [
            { key: '初剪', due: g('初剪交件日'), done: g('初剪完成'), skip: g('無初剪') },
            { key: '業配', due: g('業配交件日'), done: g('業配完成'), skip: g('無業配') },
            { key: 'ES', due: g('ES交件日'), done: g('ES完成'), skip: false },
            { key: 'Final', due: g('Final截止日'), done: g('Final完成'), skip: false },
          ],
        });
      }
      cursor = j.has_more ? j.next_cursor : undefined;
    } while (cursor);
  } catch (e) {
    return res.status(500).json({ error: 'fetch_failed', detail: String(e) });
  }
  res.status(200).json({ items, fetchedAt: Date.now() });
}
