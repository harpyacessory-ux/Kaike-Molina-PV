// CRM — painel de saúde das integrações (WhatsApp, Ads, IA, armazenamento, Instagram).
// GET /api/crm/status
// Auth: header 'x-panel-key' === process.env.PANEL_KEY

const GRAPH = 'https://graph.facebook.com/v21.0';
const ACCOUNT = 'act_1952702155392886';
const MODEL = 'claude-haiku-4-5-20251001';

const PFX = 'crm-' + process.env.CRM_PREFIX;

async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

async function checarWhatsapp(){
  try {
    const r = await fetch(GRAPH + '/' + process.env.WHATSAPP_PHONE_ID + '?fields=display_phone_number', {
      headers: { 'Authorization': 'Bearer ' + process.env.WHATSAPP_TOKEN }
    });
    const d = await r.json();
    if (!r.ok || !d.display_phone_number) {
      return { ok: false, detalhe: (d && d.error && d.error.message) || ('erro HTTP ' + r.status) };
    }
    return { ok: true, detalhe: d.display_phone_number };
  } catch (e) {
    return { ok: false, detalhe: e.message };
  }
}

async function checarAnuncios(){
  try {
    const r = await fetch(GRAPH + '/' + ACCOUNT + '?fields=name,account_status', {
      headers: { 'Authorization': 'Bearer ' + process.env.ADS_TOKEN }
    });
    const d = await r.json();
    if (!r.ok || !d.name) {
      return { ok: false, detalhe: (d && d.error && d.error.message) || ('erro HTTP ' + r.status) };
    }
    return { ok: true, detalhe: d.name + (d.account_status === 1 ? ' — conta ativa' : ' — status ' + d.account_status) };
  } catch (e) {
    return { ok: false, detalhe: e.message };
  }
}

async function checarIa(){
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
    });
    if (!r.ok) {
      let detalhe = 'erro HTTP ' + r.status;
      try { const d = await r.json(); if (d && d.error && d.error.message) detalhe = d.error.message; } catch (e) {}
      return { ok: false, detalhe };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, detalhe: e.message };
  }
}

async function checarArmazenamento(){
  try {
    const meta = await blobGet('meta/activity.json');
    return { ok: true, ultimaAtividade: (meta && meta.t) || null };
  } catch (e) {
    return { ok: false, detalhe: e.message };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'método não permitido' });
  if (!req.headers['x-panel-key'] || req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const [whatsapp, anuncios, ia, armazenamento] = await Promise.all([
    checarWhatsapp(),
    checarAnuncios(),
    checarIa(),
    checarArmazenamento()
  ]);

  return res.status(200).json({
    whatsapp,
    anuncios,
    ia,
    armazenamento,
    instagram: { ok: false, detalhe: 'Não conectado — o robô atende apenas WhatsApp. Respostas a comentários do Instagram exigem integração adicional (fase 2).' },
    geradoEm: Date.now()
  });
};
