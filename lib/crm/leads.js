// CRM — listagem e detalhe de leads salvos no Vercel Blob.
// GET /api/crm/leads            → lista resumida de todos os leads (até 100)
// GET /api/crm/leads?id=<wa_id> → objeto completo de um lead
// Auth: header 'x-panel-key' === process.env.PANEL_KEY

const PFX = 'crm-' + process.env.CRM_PREFIX;

async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

function trunc(s, n){
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function ultimoTurn(turns, role){
  if (!Array.isArray(turns)) return null;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i] && turns[i].role === role) return turns[i];
  }
  return null;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'método não permitido' });
  if (!req.headers['x-panel-key'] || req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const q = req.query || {};

  try {
    // detalhe de um lead específico
    if (q.id) {
      const lead = await blobGet('leads/' + q.id + '.json');
      if (!lead) return res.status(404).json({ error: 'lead não encontrado' });
      return res.status(200).json({ lead });
    }

    // listagem resumida
    const blobs = await blobList('leads/');
    if (!blobs.length) return res.status(200).json({ leads: [] });

    const alvos = blobs.slice(0, 100);
    const conteudos = await Promise.all(alvos.map(async (b) => {
      try {
        const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return null;
        return await r.json();
      } catch (e) {
        return null; // tolerante a falha individual
      }
    }));

    const leads = conteudos
      .filter((l) => l && l.id)
      .map((l) => {
        const u = ultimoTurn(l.turns, 'user');
        const a = ultimoTurn(l.turns, 'assistant');
        return {
          id: l.id,
          nome: l.nome || '',
          ultimaMsg: trunc(u && u.content, 120),
          ultimaResposta: trunc(a && a.content, 120),
          totalMsgs: Array.isArray(l.turns) ? l.turns.length : 0,
          atualizadoEm: l.atualizadoEm || l.criadoEm || 0,
          status: l.status || 'em_conversa'
        };
      })
      .sort((x, y) => (y.atualizadoEm || 0) - (x.atualizadoEm || 0));

    return res.status(200).json({ leads });
  } catch (e) {
    console.error('erro ao listar leads:', e.message);
    return res.status(500).json({ error: 'erro ao consultar leads' });
  }
};

// CORS: permite o CRM Harpy (e dev local) consumir a API de outro domínio; trata o preflight
function cors(req, res) {
  const origin = req.headers.origin || '';
  if (/^https:\/\/(crm-harpy\.vercel\.app|www\.nicolastasso\.site)$/.test(origin) || /^http:\/\/localhost:\d+$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-panel-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}
