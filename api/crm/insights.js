// Motor de análise do painel CRM — coleta métricas da Meta Marketing API,
// calcula KPIs contra o baseline pré-consolidação e gera recomendações com IA (Claude).
// Cache de 10 minutos em Vercel Blob para não estourar limites da Graph API.
//
// GET /api/crm/insights  (header obrigatório: x-panel-key)
//
// Variáveis de ambiente: ADS_TOKEN, ANTHROPIC_API_KEY, PANEL_KEY, CRM_PREFIX, BLOB_READ_WRITE_TOKEN

const GRAPH = 'https://graph.facebook.com/v21.0';
const ACCOUNT = 'act_1952702155392886';
const ADSET_CONSOLIDADO = '52713910773930';
const MODEL = 'claude-haiku-4-5-20251001';
const INICIO_CONSOLIDACAO = '2026-08-09';

// baseline fixo — período pré-consolidação (04 a 08/08/2026)
const BASELINE = { gasto: 99.53, cpm: 90, cpl: 24.88, leads: 4, ctr: 4.45 };

// ---- helpers de storage (Vercel Blob via REST) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

// ---- helper da Graph API ----
async function graphGet(pathAndQuery) {
  const r = await fetch(GRAPH + pathAndQuery, {
    headers: { 'Authorization': 'Bearer ' + process.env.ADS_TOKEN }
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) {
    const msg = (d && d.error && d.error.message) || ('graph http ' + r.status);
    throw new Error(msg);
  }
  return d;
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function extrairLeads(actions) {
  if (!Array.isArray(actions)) return 0;
  const a = actions.find(x => x.action_type === 'lead');
  return a ? num(a.value) : 0;
}

// aplica o estado salvo (pendente | ignorada | aplicada) sobre as recomendações
function mesclarEstado(recomendacoes, recs) {
  const estados = recs || {};
  return (recomendacoes || []).map(r => Object.assign({}, r, { estado: estados[r.id] || 'pendente' }));
}

// parse defensivo da resposta da IA — remove cercas de markdown e isola o array JSON
function parseRecomendacoes(texto) {
  if (!texto) return [];
  let t = String(texto).replace(/```(?:json)?/gi, '').trim();
  const ini = t.indexOf('[');
  const fim = t.lastIndexOf(']');
  if (ini === -1 || fim === -1 || fim <= ini) return [];
  try {
    const arr = JSON.parse(t.slice(ini, fim + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(r => r && typeof r === 'object' && r.id && r.titulo)
      .slice(0, 4)
      .map(r => ({
        id: String(r.id),
        titulo: String(r.titulo),
        motivo: String(r.motivo || ''),
        prioridade: ['alta', 'media', 'baixa'].includes(r.prioridade) ? r.prioridade : 'media',
        acao: (r.acao && typeof r.acao === 'object')
          ? { tipo: String(r.acao.tipo || 'nenhuma'), params: (r.acao.params && typeof r.acao.params === 'object') ? r.acao.params : {} }
          : { tipo: 'nenhuma', params: {} }
      }));
  } catch (e) { return []; }
}

async function gerarRecomendacoes(dados) {
  const system = 'Você é um gestor de tráfego sênior especializado em Meta Ads. Você analisa dados de campanha em JSON e gera recomendações acionáveis em português do Brasil. Responda SOMENTE com um array JSON válido, sem texto antes ou depois, sem cercas de markdown.';
  const user = `Analise os dados abaixo da conta de anúncios e gere ATÉ 4 recomendações.

REGRAS OBRIGATÓRIAS:
- A amostra é pequena — NÃO trate ruído estatístico como sinal. Só recomende com base em diferenças relevantes.
- A campanha foi consolidada e reiniciou a fase de aprendizado em 09/08/2026. NÃO sugira nenhuma mudança estrutural (trocar orçamento, pausar conjunto, alterar segmentação) nos primeiros 5 dias após 09/08/2026.
- CONDIÇÃO ESPECIAL: SE os anúncios [UTM] de ids 52714131079130 e 52714131072130 estiverem com effective_status ACTIVE E as duplicatas sem UTM de ids 52713981661330 ('IMG 1 — Lucro não aparece') e 52713983253530 ('IMG 2 — Equipe na operação') TAMBÉM estiverem ativas, inclua recomendação de pausar as duplicatas sem UTM (uma ação pausar_anuncio por duplicata, com params {"id": "<id da duplicata>"}). Se a condição não valer, não inclua essa recomendação.

FORMATO DA RESPOSTA — SOMENTE um array JSON:
[{"id": "<slug-estavel-derivado-do-titulo>", "titulo": "...", "motivo": "<justificativa com números concretos dos dados>", "prioridade": "alta"|"media"|"baixa", "acao": {"tipo": "pausar_anuncio"|"ativar_anuncio"|"pausar_conjunto"|"ajustar_orcamento"|"nenhuma", "params": {}}}]

- Para pausar_anuncio/ativar_anuncio/pausar_conjunto: params = {"id": "<id numérico do objeto>"}.
- Para ajustar_orcamento: params = {"id": "<id do conjunto>", "lifetime_budget": <valor em centavos, máximo 60000>}.
- Para nenhuma (recomendação apenas informativa): params = {}.
- O campo id da recomendação deve ser um slug estável (minúsculas, hífens), sempre o mesmo para a mesma recomendação.

DADOS:
${JSON.stringify(dados)}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !Array.isArray(d.content)) {
    const msg = (d && d.error && d.error.message) || ('anthropic http ' + r.status);
    throw new Error(msg);
  }
  const bloco = d.content.find(b => b.type === 'text');
  return parseRecomendacoes(bloco && bloco.text);
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'metodo nao permitido' });

  try {
    // ---- cache (10 minutos) — sempre re-mescla o estado das recomendações ----
    const cache = await blobGet('meta/insights-cache.json').catch(() => null);
    if (cache && cache.t > Date.now() - 600000 && cache.body) {
      const recs = await blobGet('meta/recs.json').catch(() => null);
      const body = Object.assign({}, cache.body, {
        recomendacoes: mesclarEstado(cache.body.recomendacoes, recs),
        cacheado: true
      });
      return res.status(200).json(body);
    }

    // ---- coleta da Graph API (cada bloco com try/catch próprio) ----
    const hoje = new Date().toISOString().slice(0, 10);
    const timeRange = encodeURIComponent(JSON.stringify({ since: INICIO_CONSOLIDACAO, until: hoje }));

    let totais = null, totaisErro = null;
    let porDia = [], porDiaErro = null;
    let porAnuncio = [], porAnuncioErro = null;
    let conjuntos = [], conjuntosErro = null;
    let anunciosConsolidado = [], anunciosErro = null;

    await Promise.all([
      graphGet('/' + ACCOUNT + '/insights?level=campaign&fields=spend,impressions,clicks,ctr,cpm,actions&time_range=' + timeRange)
        .then(d => { totais = (d.data && d.data[0]) || null; })
        .catch(e => { totaisErro = e.message; }),
      graphGet('/' + ACCOUNT + '/insights?level=campaign&fields=spend,impressions,clicks,ctr,cpm,actions&time_increment=1&time_range=' + timeRange)
        .then(d => { porDia = d.data || []; })
        .catch(e => { porDiaErro = e.message; }),
      graphGet('/' + ADSET_CONSOLIDADO + '/insights?level=ad&fields=ad_name,spend,impressions,clicks,ctr,actions&date_preset=maximum')
        .then(d => { porAnuncio = d.data || []; })
        .catch(e => { porAnuncioErro = e.message; }),
      graphGet('/' + ACCOUNT + '/adsets?fields=name,status,effective_status,lifetime_budget,daily_budget')
        .then(d => { conjuntos = d.data || []; })
        .catch(e => { conjuntosErro = e.message; }),
      graphGet('/' + ADSET_CONSOLIDADO + '/ads?fields=name,status,effective_status')
        .then(d => { anunciosConsolidado = d.data || []; })
        .catch(e => { anunciosErro = e.message; })
    ]);

    // ---- KPIs ----
    const gasto = totais ? num(totais.spend) : 0;
    const leads = totais ? extrairLeads(totais.actions) : 0;
    const kpis = {
      gasto,
      impressoes: totais ? num(totais.impressions) : 0,
      cliques: totais ? num(totais.clicks) : 0,
      ctr: totais ? num(totais.ctr) : 0,
      cpm: totais ? num(totais.cpm) : 0,
      leads,
      cpl: leads > 0 ? Math.round((gasto / leads) * 100) / 100 : null
    };
    if (totaisErro) kpis.erro = totaisErro;

    porDia = porDia.map(d => ({
      data: d.date_start,
      gasto: num(d.spend),
      impressoes: num(d.impressions),
      cliques: num(d.clicks),
      ctr: num(d.ctr),
      cpm: num(d.cpm),
      leads: extrairLeads(d.actions)
    }));

    porAnuncio = porAnuncio.map(a => {
      const g = num(a.spend);
      const l = extrairLeads(a.actions);
      const ad = anunciosConsolidado.find(x => x.name === a.ad_name);
      return {
        nome: a.ad_name,
        gasto: g,
        impressoes: num(a.impressions),
        cliques: num(a.clicks),
        ctr: num(a.ctr),
        leads: l,
        cpl: l > 0 ? Math.round((g / l) * 100) / 100 : null,
        effective_status: ad ? ad.effective_status : null
      };
    });

    // ---- recomendações via IA (falha da IA não derruba o endpoint) ----
    let recomendacoes = [];
    let recomendacoesErro = null;
    try {
      recomendacoes = await gerarRecomendacoes({
        kpis, baseline: BASELINE, porDia, porAnuncio, conjuntos, anunciosConsolidado
      });
    } catch (e) {
      recomendacoesErro = e.message;
    }

    const body = {
      kpis,
      baseline: BASELINE,
      porDia,
      porAnuncio,
      conjuntos,
      anunciosConsolidado,
      recomendacoes,
      geradoEm: new Date().toISOString()
    };
    if (porDiaErro) body.porDiaErro = porDiaErro;
    if (porAnuncioErro) body.porAnuncioErro = porAnuncioErro;
    if (conjuntosErro) body.conjuntosErro = conjuntosErro;
    if (anunciosErro) body.anunciosConsolidadoErro = anunciosErro;
    if (recomendacoesErro) body.recomendacoesErro = recomendacoesErro;

    // salva o cache com as recomendações brutas (sem estado) e responde com o estado mesclado
    try { await blobPut('meta/insights-cache.json', { t: Date.now(), body }); } catch (e) { /* cache é melhor-esforço */ }

    const recs = await blobGet('meta/recs.json').catch(() => null);
    return res.status(200).json(Object.assign({}, body, {
      recomendacoes: mesclarEstado(recomendacoes, recs),
      cacheado: false
    }));
  } catch (e) {
    console.error('insights erro:', e.message);
    return res.status(500).json({ error: 'erro ao gerar insights', detalhe: e.message });
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
