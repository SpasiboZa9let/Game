// Cloudflare Worker для игры «Башня»: попытки, покупка попыток за Telegram Stars, общий рейтинг.
// Секреты (Settings → Variables and Secrets):
//   BOT_TOKEN       токен бота из BotFather (хранить ТОЛЬКО здесь)
//   SETUP_KEY       длинная случайная строка, чтобы только ты мог вызвать /setup
//   WEBHOOK_SECRET  случайная строка из букв и цифр (проверяет, что запросы идут от Telegram)
// Обычные переменные (необязательно):
//   PRICE           цена одной попытки в звёздах (по умолчанию 10)
//   PAY_CONTACT     текст для команды /paysupport (как с тобой связаться по платежам)
// Привязка KV (Bindings → KV namespace): имя переменной TOP

const FREE = 5;          // бесплатных попыток
const COOLDOWN = 3600;   // секунд ожидания после того, как бесплатные кончились

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const enc = new TextEncoder();
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const nowSec = () => Math.floor(Date.now() / 1000);
const price = (env) => Math.max(1, parseInt(env.PRICE || '10', 10));

async function hmac(key, data) {
  const k = await crypto.subtle.importKey(
    'raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

// Проверка подписи данных Mini App (initData): подделать игрока нельзя
async function verifyInitData(initData, token) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const h = p.get('hash');
  if (!h) return null;
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = await hmac('WebAppData', token);
  if (hex(await hmac(secret, str)) !== h) return null;
  if (nowSec() - Number(p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

async function tgApi(env, method, body) {
  const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}

// ----- попытки игрока -----
async function getU(env, id) {
  const u = (await env.TOP.get('u:' + id, 'json')) || { free: FREE, refillAt: 0, paid: 0, run: 0 };
  if (u.free <= 0 && u.refillAt && nowSec() >= u.refillAt) { u.free = FREE; u.refillAt = 0; }
  return u;
}
const putU = (env, id, u) => env.TOP.put('u:' + id, JSON.stringify(u));
const view = (u, env) => ({ free: u.free, paid: u.paid, refillAt: u.refillAt, now: nowSec(), price: price(env), max: FREE });

async function auth(req, env) {
  let b = {};
  try { b = await req.json(); } catch (e) {}
  const user = await verifyInitData(b.initData, env.BOT_TOKEN);
  return { b, user };
}

async function state(req, env) {
  const { user } = await auth(req, env);
  if (!user) return json({ error: 'bad initData' }, 401);
  return json(view(await getU(env, user.id), env));
}

async function start(req, env) {
  const { user } = await auth(req, env);
  if (!user) return json({ error: 'bad initData' }, 401);
  const u = await getU(env, user.id);
  if (u.free > 0) {
    u.free--;
    if (u.free === 0) u.refillAt = nowSec() + COOLDOWN;
  } else if (u.paid > 0) {
    u.paid--;
  } else {
    await putU(env, user.id, u);
    return json({ error: 'no attempts', ...view(u, env) }, 403);
  }
  u.run = nowSec();
  await putU(env, user.id, u);
  return json(view(u, env));
}

// ----- рейтинг -----
async function getTop(env) { return (await env.TOP.get('top', 'json')) || []; }
const pub = (list) => list.slice(0, 5).map((r) => ({ name: r.name, score: r.score }));

async function score(req, env) {
  const { b, user } = await auth(req, env);
  if (!user) return json({ error: 'bad initData' }, 401);
  const u = await getU(env, user.id);
  const sc = Math.floor(Number(b.score));
  const elapsed = nowSec() - u.run;
  // очки засчитываются только за начатую попытку и не быстрее разумного темпа
  const ok = u.run > 0 && sc >= 0 && sc <= 5000 && sc <= elapsed * 3 + 5;
  u.run = 0;
  await putU(env, user.id, u);
  if (!ok) return json({ error: 'bad score', ...view(u, env) }, 400);
  const list = await getTop(env);
  const name = String(user.first_name || 'игрок').slice(0, 16);
  const i = list.findIndex((r) => r.id === user.id);
  if (i >= 0) { if (list[i].score < sc) { list[i].score = sc; list[i].name = name; } }
  else list.push({ id: user.id, name, score: sc });
  list.sort((a, c) => c.score - a.score);
  const keep = list.slice(0, 20);
  await env.TOP.put('top', JSON.stringify(keep));
  return json({ top: pub(keep), ...view(u, env) });
}

// ----- покупка попыток за Stars -----
async function buy(req, env) {
  const { b, user } = await auth(req, env);
  if (!user) return json({ error: 'bad initData' }, 401);
  const qty = Math.min(10, Math.max(1, parseInt(b.qty || '1', 10)));
  const inv = await tgApi(env, 'createInvoiceLink', {
    title: qty === 1 ? 'Попытка в «Башне»' : qty + ' попыток в «Башне»',
    description: 'Дополнительные попытки не сгорают.',
    payload: 'buy:' + user.id + ':' + qty,
    currency: 'XTR',
    prices: [{ label: 'Попытки ×' + qty, amount: price(env) * qty }]
  });
  if (!inv.ok) return json({ error: 'invoice failed' }, 500);
  return json({ link: inv.result });
}

function parsePayload(p) {
  const m = /^buy:(\d+):(\d+)$/.exec(p || '');
  return m ? { id: Number(m[1]), qty: Number(m[2]) } : null;
}

async function webhook(req, env) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
    return new Response('forbidden', { status: 403 });
  const upd = await req.json();
  const pq = upd.pre_checkout_query;
  if (pq) {
    // Ответить нужно за 10 секунд, иначе платёж отменится
    const pl = parsePayload(pq.invoice_payload);
    const good = pl && pl.id === pq.from.id && pq.currency === 'XTR' && pq.total_amount === price(env) * pl.qty;
    await tgApi(env, 'answerPreCheckoutQuery', good
      ? { pre_checkout_query_id: pq.id, ok: true }
      : { pre_checkout_query_id: pq.id, ok: false, error_message: 'Не удалось проверить платёж' });
  } else if (upd.message && upd.message.successful_payment) {
    const sp = upd.message.successful_payment, pl = parsePayload(sp.invoice_payload);
    const seen = await env.TOP.get('c:' + sp.telegram_payment_charge_id);
    if (pl && pl.id === upd.message.from.id && !seen) {
      const u = await getU(env, pl.id);
      u.paid += pl.qty;
      await putU(env, pl.id, u);
      await env.TOP.put('c:' + sp.telegram_payment_charge_id, '1', { expirationTtl: 60 * 60 * 24 * 90 });
      await tgApi(env, 'sendMessage', { chat_id: upd.message.chat.id, text: 'Спасибо! Добавлено попыток: ' + pl.qty + ' ❤️' });
    }
  } else if (upd.message && /^\/paysupport/.test(upd.message.text || '')) {
    await tgApi(env, 'sendMessage', {
      chat_id: upd.message.chat.id,
      text: env.PAY_CONTACT || 'По вопросам платежей и возвратов напишите владельцу бота.'
    });
  }
  return new Response('ok');
}

// Один раз открой в браузере: /setup?key=SETUP_KEY — включает вебхук
async function setup(url, env) {
  if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) return json({ error: 'forbidden' }, 403);
  const hook = await tgApi(env, 'setWebhook', {
    url: url.origin + '/webhook',
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'pre_checkout_query']
  });
  return json({ webhook: hook.ok, detail: hook.ok ? undefined : hook });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      const post = req.method === 'POST';
      if (url.pathname === '/webhook' && post) return await webhook(req, env);
      if (url.pathname === '/setup') return await setup(url, env);
      if (url.pathname === '/top') return json(pub(await getTop(env)));
      if (url.pathname === '/state' && post) return await state(req, env);
      if (url.pathname === '/start' && post) return await start(req, env);
      if (url.pathname === '/score' && post) return await score(req, env);
      if (url.pathname === '/buy' && post) return await buy(req, env);
    } catch (e) { return json({ error: String(e) }, 500); }
    return json({ error: 'not found' }, 404);
  }
};
