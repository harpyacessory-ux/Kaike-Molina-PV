// Série histórica do painel — lê as fotos diárias gravadas por /api/crm/snapshot.
//
// GET /api/crm/historico  (header obrigatório: x-panel-key)
//   → { serie: [ {data, t, gasto, impressoes, cliques, ctr, cpm, leads, cpl, porAnuncio}, ... ], baseline }
//   A série vem ordenada por data crescente (mais antiga primeiro), no máximo 120 dias.
//
// Variáveis de ambiente: PANEL_KEY, CRM_PREFIX, BLOB_READ_WRITE_TOKEN

const MAX_DIAS = 120;

// baseline fixo — período pré-consolidação (04 a 08/08/2026), o mesmo de insights.js
const BASELINE = { gasto: 99.53, cpm: 90, cpl: 24.88, leads: 4, ctr: 4.45 };

// ---- helpers de storage (Vercel Blob via REST) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

function ordenarPorNome(a, b) {
  const pa = a.pathname || '';
  const pb = b.pathname || '';
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return 0;
}

// mantém uma foto por dia: se houver duplicata do mesmo dia, vence a mais recente
function deduplicarPorDia(registros) {
  const porDia = {};
  for (const r of registros) {
    const atual = porDia[r.data];
    if (!atual || (r.t || 0) >= (atual.t || 0)) porDia[r.data] = r;
  }
  return Object.keys(porDia).sort().map(d => porDia[d]);
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'metodo nao permitido' });

  try {
    const blobs = await blobList('historico/');
    if (!blobs.length) return res.status(200).json({ serie: [], baseline: BASELINE });

    // o nome do arquivo é a data, então ordenar por pathname já ordena por dia:
    // pegamos os MAX_DIAS mais recentes do fim da lista
    const recentes = blobs.slice().sort(ordenarPorNome).slice(-MAX_DIAS);

    // uma foto corrompida ou fora do ar não pode derrubar o histórico inteiro
    const brutos = await Promise.all(recentes.map(async b => {
      try {
        const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return null;
        return await r.json();
      } catch (e) { return null; }
    }));

    const serie = deduplicarPorDia(
      brutos.filter(r => r && typeof r === 'object' && typeof r.data === 'string')
    );

    return res.status(200).json({ serie, baseline: BASELINE });
  } catch (e) {
    console.error('historico erro:', e.message);
    return res.status(500).json({ error: 'erro ao ler o historico', detalhe: e.message });
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
