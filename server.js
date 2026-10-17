const http = require('http'), fs = require('fs'), path = require('path');
const { GOOGLE_KEY = '', FINNHUB_KEY = '', APP_CODE = '', GEMINI_MODEL = 'gemini-3.5-flash-lite' } = process.env;
const PORT = process.env.PORT || 3000;

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise(resolve => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
  req.on('end', () => resolve(d));
});

async function gemini(messages, GOOGLE_KEY) {
  const model = encodeURIComponent(GEMINI_MODEL);
  const payloadFor = withSearch => JSON.stringify({
    contents: messages.map((m, i) => {
      let text = String(m.content);
      if (!withSearch && i === messages.length - 1) {
        text = 'הערה: חיפוש גוגל אינו זמין כרגע. הסתמך על הידע שלך בלבד, אל תמציא חדשות או מחירים עדכניים, וציין שאין לך נתונים עדכניים.\n' + text;
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
    }),
    ...(withSearch ? { tools: [{ googleSearch: {} }] } : {}),
    generationConfig: { maxOutputTokens: 8000 }
  });
  const targets = [
    { n: 'Gemini', u: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, h: { 'content-type': 'application/json', 'x-goog-api-key': GOOGLE_KEY } },
    { n: 'Vertex', u: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(GOOGLE_KEY)}`, h: { 'content-type': 'application/json' } }
  ];
  const errs = [];
  let quota = false;
  for (const t of targets) {
    if (quota) break; // חריגה ממכסה: אין טעם לנסות כתובת אחרת
    for (const withSearch of [true, false]) {
      const tag = t.n + (withSearch ? '' : ' (בלי חיפוש)');
      try {
        const r = await fetch(t.u, { method: 'POST', headers: t.h, body: payloadFor(withSearch) });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const x = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
          if (x) return x;
          errs.push(tag + ': empty response');
          break;
        }
        errs.push(`${tag} (${r.status}): ${j.error?.message || 'error'}`);
        if (r.status === 429) { quota = true; continue; } // ננסה שוב בלי חיפוש
        break;
      } catch (e) { errs.push(tag + ': ' + e.message); break; }
    }
  }
  throw new Error(errs.join(' | '));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return send(res, 200, { GOOGLE_KEY: !!GOOGLE_KEY, FINNHUB_KEY: !!FINNHUB_KEY, APP_CODE: !!APP_CODE, namesSeenByServer: Object.keys(process.env).filter(k => /GOOGLE|FINN|APP_|GEMINI|KEY/i.test(k)) });
  if (url.pathname.startsWith('/api/')) {
    if (APP_CODE && req.headers['x-app-code'] !== APP_CODE) return send(res, 401, { error: 'unauthorized' });
    try {
      if (url.pathname === '/api/llm' && req.method === 'POST') {
        const gk = GOOGLE_KEY || String(req.headers['x-google-key'] || '').trim();
        if (!gk) return send(res, 500, { error: 'מפתח Google לא מוגדר. הוסף אותו ב-Render או בהגדרות הדף.' });
        const { messages } = JSON.parse(await readBody(req));
        return send(res, 200, { text: await gemini(messages, gk) });
      }
      if (url.pathname === '/api/quote') {
        const fk = FINNHUB_KEY || String(req.headers['x-finnhub-key'] || '').trim();
        if (!fk) return send(res, 500, { error: 'מפתח Finnhub לא מוגדר. הוסף אותו ב-Render או בהגדרות הדף.' });
        const s = (url.searchParams.get('symbol') || '').toUpperCase();
        if (!/^[A-Z.\-]{1,10}$/.test(s)) return send(res, 400, { error: 'bad symbol' });
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${encodeURIComponent(fk)}`);
        return send(res, r.status, await r.json().catch(() => ({})));
      }
      if (url.pathname === '/api/search') {
        const fk = FINNHUB_KEY || String(req.headers['x-finnhub-key'] || '').trim();
        if (!fk) return send(res, 500, { error: 'מפתח Finnhub לא מוגדר. הוסף אותו ב-Render או בהגדרות הדף.' });
        const q = (url.searchParams.get('q') || '').slice(0, 60);
        if (!q) return send(res, 400, { error: 'empty query' });
        const r = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(fk)}`);
        return send(res, r.status, await r.json().catch(() => ({})));
      }
      if (url.pathname === '/api/news') {
        const fk = FINNHUB_KEY || String(req.headers['x-finnhub-key'] || '').trim();
        if (!fk) return send(res, 500, { error: 'מפתח Finnhub לא מוגדר. הוסף אותו ב-Render או בהגדרות הדף.' });
        const sym = (url.searchParams.get('symbol') || '').toUpperCase();
        const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
        const dre = /^\d{4}-\d{2}-\d{2}$/;
        if (!/^[A-Z.\-]{1,10}$/.test(sym) || !dre.test(from) || !dre.test(to)) return send(res, 400, { error: 'bad params' });
        const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${from}&to=${to}&token=${encodeURIComponent(fk)}`);
        const j = await r.json().catch(() => []);
        return send(res, r.status, Array.isArray(j) ? j.slice(0, 40) : j);
      }
      if (url.pathname === '/api/metric') {
        const fk = FINNHUB_KEY || String(req.headers['x-finnhub-key'] || '').trim();
        if (!fk) return send(res, 500, { error: 'מפתח Finnhub לא מוגדר. הוסף אותו ב-Render או בהגדרות הדף.' });
        const sym = (url.searchParams.get('symbol') || '').toUpperCase();
        if (!/^[A-Z.\-]{1,10}$/.test(sym)) return send(res, 400, { error: 'bad symbol' });
        const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${encodeURIComponent(fk)}`);
        const j = await r.json().catch(() => ({}));
        const keep = ['marketCapitalization', 'peTTM', 'peBasicExclExtraTTM', 'epsTTM', 'beta', '52WeekHigh', '52WeekLow', 'dividendYieldIndicatedAnnual', 'revenueGrowthTTMYoy', 'netProfitMarginTTM', 'roeTTM'];
        const metric = {};
        for (const k of keep) if (j.metric && j.metric[k] != null) metric[k] = j.metric[k];
        return send(res, r.status, { metric });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }
  let files = [];
  try { files = fs.readdirSync(__dirname); } catch (e) {}
  const htmls = files.filter(n => n.toLowerCase().endsWith('.html'));
  const file = htmls.includes('index.html') ? 'index.html' : htmls[0];
  if (!file) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('לא נמצא קובץ HTML ליד server.js. הקבצים שנמצאו: ' + (files.join(', ') || 'אין'));
  }
  fs.readFile(path.join(__dirname, file), (e, d) => {
    if (e) { res.writeHead(500); return res.end('שגיאה בקריאת הקובץ'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(d);
  });
}).listen(PORT, () => console.log('listening on ' + PORT));
