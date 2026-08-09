// Armazenamento das coleções do CRM do painel (funil, contatos, tarefas) em Vercel Blob.
//
// GET  /api/crm/store?col=funil|contatos|tarefas  → { doc, atualizadoEm }
// POST /api/crm/store  body { col, doc }          → { ok: true }
//
// O GET do funil mescla automaticamente os leads do robô do WhatsApp como cards:
// lead novo vira card em "Conversando" (ou "Qualificado", conforme o status do lead);
// um card que ainda está em "Conversando" sobe sozinho para "Qualificado" quando o
// robô qualifica o lead — movimentos manuais para outras colunas nunca são desfeitos.

const COLECOES = ['funil', 'contatos', 'tarefas'];
const TAMANHO_MAX = 900 * 1024; // ~900KB por documento

const FUNIL_PADRAO = {
  colunas: [
    { id: 'novo', titulo: 'Novo' },
    { id: 'conversando', titulo: 'Conversando' },
    { id: 'qualificado', titulo: 'Qualificado' },
    { id: 'negociacao', titulo: 'Em negociação' },
    { id: 'ganhou', titulo: 'Ganhou' },
    { id: 'perdeu', titulo: 'Perdeu' }
  ],
  cards: []
};

// ---- helpers de storage (Vercel Blob via REST) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

// lê todos os leads persistidos pelo robô (limite 200)
async function lerLeads(){
  const blobs = (await blobList('leads/')).slice(0, 200);
  const leads = await Promise.all(blobs.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }));
  return leads.filter(l => l && l.id);
}

// mescla os leads do robô no documento do funil; retorna [doc, mudou]
function mesclarLeadsNoFunil(doc, leads){
  let mudou = false;
  const porLead = {};
  for (const c of doc.cards) if (c.leadId) porLead[c.leadId] = c;

  for (const lead of leads) {
    const existente = porLead[lead.id];
    if (!existente) {
      doc.cards.push({
        id: 'card-' + lead.id,
        leadId: lead.id,
        nome: lead.nome || lead.id,
        whatsapp: lead.id,
        valor: null,
        notas: '',
        origem: 'robo',
        coluna: lead.status === 'qualificado' ? 'qualificado' : 'conversando',
        criadoEm: lead.criadoEm || Date.now(),
        atualizadoEm: Date.now()
      });
      mudou = true;
    } else if (existente.coluna === 'conversando' && lead.status === 'qualificado') {
      existente.coluna = 'qualificado';
      existente.atualizadoEm = Date.now();
      mudou = true;
    }
  }
  return [doc, mudou];
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const col = (req.query && req.query.col) || '';
      if (!COLECOES.includes(col)) return res.status(400).json({ error: 'coleção inválida' });

      let salvo = await blobGet('appdata/' + col + '.json').catch(() => null);
      let doc = (salvo && salvo.doc) || null;

      if (col === 'funil') {
        if (!doc || !Array.isArray(doc.cards)) doc = JSON.parse(JSON.stringify(FUNIL_PADRAO));
        if (!Array.isArray(doc.colunas) || !doc.colunas.length) doc.colunas = FUNIL_PADRAO.colunas;
        const leads = await lerLeads().catch(() => []);
        const [mesclado, mudou] = mesclarLeadsNoFunil(doc, leads);
        doc = mesclado;
        if (mudou) {
          try { await blobPut('appdata/funil.json', { doc, atualizadoEm: Date.now() }); } catch (e) { /* melhor-esforço */ }
        }
      }

      return res.status(200).json({ doc: doc, atualizadoEm: (salvo && salvo.atualizadoEm) || null });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const col = body.col;
      if (!COLECOES.includes(col)) return res.status(400).json({ error: 'coleção inválida' });
      if (!body.doc || typeof body.doc !== 'object') return res.status(400).json({ error: 'doc obrigatório' });
      if (JSON.stringify(body.doc).length > TAMANHO_MAX) return res.status(413).json({ error: 'documento grande demais' });

      await blobPut('appdata/' + col + '.json', { doc: body.doc, atualizadoEm: Date.now() });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'método não permitido' });
  } catch (e) {
    console.error('store erro:', e.message);
    return res.status(500).json({ error: e.message });
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
