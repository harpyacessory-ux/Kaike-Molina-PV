// Aplicação/descarte de recomendações do painel CRM — executa ações na Meta Marketing API
// (pausar/ativar anúncio, pausar conjunto, ajustar orçamento), registra auditoria e
// atualiza o estado da recomendação em Vercel Blob.
//
// POST /api/crm/apply  (header obrigatório: x-panel-key)
// Body: { recId, decisao: 'aplicar'|'ignorar', acao: { tipo, params } }
//
// Variáveis de ambiente: ADS_TOKEN, PANEL_KEY, CRM_PREFIX, BLOB_READ_WRITE_TOKEN

const GRAPH = 'https://graph.facebook.com/v21.0';

const TIPOS_PERMITIDOS = ['pausar_anuncio', 'ativar_anuncio', 'pausar_conjunto', 'ajustar_orcamento', 'nenhuma'];
const ID_REGEX = /^527[0-9]{10,}$/;
const ORCAMENTO_MAX_CENTAVOS = 60000; // R$ 600,00

// ---- helpers de storage (Vercel Blob via REST) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

// POST na Graph API (form-encoded) com Bearer ADS_TOKEN
async function graphPost(objectId, campos) {
  const r = await fetch(GRAPH + '/' + objectId, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.ADS_TOKEN,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(campos).toString()
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) {
    const msg = (d && d.error && d.error.message) || ('graph http ' + r.status);
    throw new Error(msg);
  }
  return d;
}

// extrai o id alvo dos params (a IA pode nomear de formas diferentes)
function extrairId(params) {
  if (!params || typeof params !== 'object') return null;
  const bruto = params.id || params.adId || params.anuncioId || params.adsetId || params.conjuntoId || null;
  return bruto == null ? null : String(bruto);
}

async function marcarEstado(recId, estado) {
  const atual = (await blobGet('meta/recs.json')) || {};
  atual[recId] = estado;
  await blobPut('meta/recs.json', atual);
}

module.exports = async (req, res) => {
  if (req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo nao permitido' });

  try {
    const body = req.body || {};
    const recId = body.recId;
    const decisao = body.decisao;
    const acao = body.acao;

    if (!recId || typeof recId !== 'string') {
      return res.status(400).json({ ok: false, erro: 'recId obrigatório' });
    }

    // ---- ignorar: só atualiza o estado da recomendação ----
    if (decisao === 'ignorar') {
      await marcarEstado(recId, 'ignorada');
      return res.status(200).json({ ok: true });
    }

    if (decisao !== 'aplicar') {
      return res.status(400).json({ ok: false, erro: "decisao deve ser 'aplicar' ou 'ignorar'" });
    }

    // ---- aplicar: valida a ação contra a whitelist ----
    if (!acao || typeof acao !== 'object' || !TIPOS_PERMITIDOS.includes(acao.tipo)) {
      return res.status(400).json({ ok: false, erro: 'tipo de ação inválido' });
    }

    let resultado = null;

    if (acao.tipo === 'nenhuma') {
      // ação informativa — só marca como aplicada
      resultado = { info: 'nenhuma ação executada' };
    } else {
      const id = extrairId(acao.params);
      if (!id || !ID_REGEX.test(id)) {
        return res.status(400).json({ ok: false, erro: 'id do objeto inválido' });
      }

      let campos;
      if (acao.tipo === 'pausar_anuncio' || acao.tipo === 'pausar_conjunto') {
        campos = { status: 'PAUSED' };
      } else if (acao.tipo === 'ativar_anuncio') {
        campos = { status: 'ACTIVE' };
      } else { // ajustar_orcamento
        const orcamento = parseInt(acao.params && acao.params.lifetime_budget, 10);
        if (!Number.isFinite(orcamento) || orcamento <= 0 || orcamento > ORCAMENTO_MAX_CENTAVOS) {
          return res.status(400).json({ ok: false, erro: 'lifetime_budget inválido (máximo ' + ORCAMENTO_MAX_CENTAVOS + ' centavos)' });
        }
        campos = { lifetime_budget: String(orcamento) };
      }

      try {
        resultado = await graphPost(id, campos);
      } catch (e) {
        return res.status(400).json({ ok: false, erro: e.message });
      }
    }

    // ---- auditoria: lê o array existente, acrescenta e grava ----
    try {
      const auditoria = (await blobGet('meta/audit.json')) || [];
      auditoria.push({ t: Date.now(), recId, acao, resultado });
      await blobPut('meta/audit.json', auditoria);
    } catch (e) {
      console.error('falha ao gravar auditoria:', e.message);
    }

    // marca a recomendação como aplicada
    await marcarEstado(recId, 'aplicada');

    // invalida o cache de insights (força recoleta na próxima consulta)
    try { await blobPut('meta/insights-cache.json', { t: 0 }); } catch (e) { /* melhor-esforço */ }

    return res.status(200).json({ ok: true, resultado });
  } catch (e) {
    console.error('apply erro:', e.message);
    return res.status(500).json({ ok: false, erro: e.message });
  }
};
