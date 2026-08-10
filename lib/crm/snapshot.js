// Foto diária das métricas — congela os KPIs do dia em Vercel Blob para montar o histórico.
// Sem isso o painel só enxerga o "agora": a Graph API não devolve o passado consolidado
// do jeito que o painel calcula, então guardamos uma foto por dia.
//
// GET|POST /api/crm/snapshot
//   auth: header x-panel-key (painel) OU Authorization: Bearer <CRON_SECRET> (cron da Vercel)
//
// Grava em blob: historico/<YYYY-MM-DD>.json (fuso de São Paulo).
// Rodar mais de uma vez no mesmo dia é seguro e proposital: a última foto do dia vence.
//
// Variáveis de ambiente: PANEL_KEY, CRON_SECRET, CRM_PREFIX, BLOB_READ_WRITE_TOKEN

// ---- helpers de storage (Vercel Blob via REST) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

function num(v) { const n = parseFloat(v); return isNaN(n) || !isFinite(n) ? 0 : n; }
function numOuNulo(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) || !isFinite(n) ? null : n;
}

// data de hoje no fuso de São Paulo (UTC-3), sem depender de Intl no runtime
function dataSaoPaulo() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// aceita a chave do painel (uso manual) ou o segredo do cron (uso automático)
function autorizado(req) {
  const chave = req.headers['x-panel-key'];
  if (process.env.PANEL_KEY && chave === process.env.PANEL_KEY) return true;
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET) return true;
  return false;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (!autorizado(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'metodo nao permitido' });
  }

  try {
    // chama o próprio /api/crm/insights (mesma implantação) para reaproveitar todo o cálculo de KPIs
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) throw new Error('host indisponivel');

    const r = await fetch('https://' + host + '/api/crm/insights', {
      headers: { 'x-panel-key': process.env.PANEL_KEY }
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) {
      const msg = (d && (d.detalhe || d.error)) || ('insights http ' + r.status);
      throw new Error(msg);
    }

    const k = d.kpis || {};
    // se a Meta falhou, os KPIs vêm zerados — gravar isso envenenaria os gráficos para sempre
    if (k.erro) {
      return res.status(502).json({ error: 'insights indisponivel', detalhe: String(k.erro) });
    }

    const data = dataSaoPaulo();
    const registro = {
      data,
      t: Date.now(),
      gasto: num(k.gasto),
      impressoes: num(k.impressoes),
      cliques: num(k.cliques),
      ctr: num(k.ctr),
      cpm: num(k.cpm),
      leads: num(k.leads),
      cpl: numOuNulo(k.cpl),
      porAnuncio: (Array.isArray(d.porAnuncio) ? d.porAnuncio : []).map(a => ({
        nome: String(a.nome || ''),
        gasto: num(a.gasto),
        cliques: num(a.cliques),
        leads: num(a.leads)
      }))
    };

    await blobPut('historico/' + data + '.json', registro);
    return res.status(200).json({ ok: true, data, registro });
  } catch (e) {
    console.error('snapshot erro:', e.message);
    return res.status(500).json({ error: 'erro ao registrar a foto do dia', detalhe: e.message });
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
