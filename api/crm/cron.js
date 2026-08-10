// CRM — rotina diária da plataforma (Vercel Cron: "0 11 * * *" = 11h UTC = 8h de Brasília).
//
// GET|POST /api/crm/cron
// Auth: header 'authorization' === 'Bearer ' + process.env.CRON_SECRET  (é o que a Vercel manda)
//       OU header 'x-panel-key' === process.env.PANEL_KEY  (para disparar à mão pelo painel)
//
// Quatro passos, cada um em try/catch ISOLADO — um passo que falha nunca derruba os outros:
//   1. renova o token do Instagram (lib/ig-token)
//   2. dispara a foto do dia (/api/crm/snapshot)
//   3. checa a saúde das integrações (/api/crm/status) e notifica o que estiver quebrado
//   4. monta o resumo diário (/api/crm/insights + /api/crm/leads) e notifica
//
// Responde sempre 200 com { ok:true, passos:{...} } — o log de cada passo fica no corpo.
//
// Variáveis de ambiente: CRON_SECRET, PANEL_KEY, CRM_PREFIX, BLOB_READ_WRITE_TOKEN,
//                        ADS_TOKEN, ANTHROPIC_API_KEY, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, IG_TOKEN

const { registrar } = require('../../lib/notificar');

// baseline fixo — período pré-consolidação (04 a 08/08/2026), o mesmo de api/crm/insights.js
const BASELINE = { gasto: 99.53, cpm: 90, cpl: 24.88, leads: 4, ctr: 4.45 };

const TIMEOUT_CURTO = 12000;  // ms — status, leads, snapshot
const TIMEOUT_LONGO = 25000;  // ms — insights (fala com a Graph API e com o Claude)
const DIA_MS = 86400000;

// ------------------------------------------------------------------ formatação (pt-BR)

function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }

// 1234567.8 → "1.234.567,80"
function decimal(v, casas) {
  const n = num(v);
  const partes = Math.abs(n).toFixed(casas === undefined ? 2 : casas).split('.');
  partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (n < 0 ? '-' : '') + partes.join(',');
}
function brl(v) { return 'R$ ' + decimal(v, 2); }
function inteiro(v) { return decimal(v, 0); }
function pct(v) { return decimal(v, 2) + '%'; }

// variação percentual contra o baseline, com sinal explícito
function variacao(atual, base) {
  const a = num(atual), b = num(base);
  if (!b) return '';
  const d = ((a - b) / b) * 100;
  return ' (' + (d >= 0 ? '+' : '') + decimal(d, 1) + '%)';
}

// data de Brasília (UTC-3) no formato dd/mm/aaaa — o cron roda 8h da manhã daqui
function dataBrasilia() {
  const d = new Date(Date.now() - 3 * 3600000);
  const iso = d.toISOString().slice(0, 10).split('-');
  return iso[2] + '/' + iso[1] + '/' + iso[0];
}

// ------------------------------------------------------------------ chamadas internas

function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = host.indexOf('localhost') === 0 || host.indexOf('127.0.0.1') === 0 ? 'http' : 'https';
  return proto + '://' + host;
}

// fetch com timeout e leitura de JSON tolerante. Lança com mensagem legível.
async function chamar(url, opcoes, ms) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, ms || TIMEOUT_CURTO) : null;
  try {
    const opts = Object.assign({}, opcoes || {});
    opts.headers = Object.assign({ 'x-panel-key': process.env.PANEL_KEY || '' }, opts.headers || {});
    if (ctrl) opts.signal = ctrl.signal;
    const r = await fetch(url, opts);
    let corpo = null;
    try { corpo = await r.json(); } catch (e) { corpo = null; }
    if (!r.ok) {
      const msg = (corpo && (corpo.error || corpo.detalhe)) || ('erro HTTP ' + r.status);
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return corpo || {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ passos

// 1. token do Instagram — o módulo já é à prova de falha, mas o require também vai protegido
async function passoToken() {
  const mod = require('../../lib/ig-token');
  const r = await mod.renovarSePreciso(false);
  return Object.assign({ ok: !r.erro }, r);
}

// 2. foto do dia — delegada ao endpoint /api/crm/snapshot (criado à parte).
// Tenta POST e cai para GET quando o endpoint só aceita leitura; ausência dele não é fatal.
async function passoSnapshot(req) {
  const url = baseUrl(req) + '/api/crm/snapshot';
  try {
    const d = await chamar(url, { method: 'POST' }, TIMEOUT_CURTO);
    return { ok: true, metodo: 'POST', resposta: d };
  } catch (e) {
    if (e && (e.status === 404 || e.status === 405)) {
      const d = await chamar(url, { method: 'GET' }, TIMEOUT_CURTO);
      return { ok: true, metodo: 'GET', resposta: d };
    }
    throw e;
  }
}

const NOMES = {
  whatsapp: 'WhatsApp',
  anuncios: 'Meta Ads',
  ia: 'IA (Claude)',
  armazenamento: 'Armazenamento (Vercel Blob)',
  instagram: 'Instagram'
};

// 3. saúde das integrações — cada uma com ok:false vira uma notificação (com WhatsApp)
async function passoSaude(req) {
  const d = await chamar(baseUrl(req) + '/api/crm/status', { method: 'GET' }, TIMEOUT_CURTO);
  const problemas = [];
  for (const chave of Object.keys(d)) {
    const v = d[chave];
    if (!v || typeof v !== 'object' || v.ok !== false) continue;
    const nome = NOMES[chave] || chave;
    problemas.push(nome);
    await registrar(
      'saude',
      'Integração com problema: ' + nome,
      'A checagem automática das ' + dataBrasilia() + ' encontrou a integração ' + nome + ' fora do ar.\n\n' +
      'Detalhe: ' + (v.detalhe || 'sem detalhe informado') + '\n\n' +
      'Enquanto isso não for resolvido, a parte do painel que depende dessa integração fica sem dados.',
      { whatsapp: true }
    );
  }
  return { ok: true, verificadas: Object.keys(NOMES).length, problemas, total: problemas.length };
}

// leads criados/atualizados nas últimas 24h
async function contarLeads24h(req) {
  const d = await chamar(baseUrl(req) + '/api/crm/leads', { method: 'GET' }, TIMEOUT_CURTO);
  const leads = Array.isArray(d.leads) ? d.leads : [];
  const corte = Date.now() - DIA_MS;
  const recentes = leads.filter(l => l && num(l.atualizadoEm) > corte);
  return {
    total: leads.length,
    novos: recentes.length,
    qualificados: recentes.filter(l => l.status === 'qualificado').length
  };
}

// 4. resumo diário — KPIs do período consolidado contra o baseline + leads das últimas 24h
async function passoResumo(req) {
  const insights = await chamar(baseUrl(req) + '/api/crm/insights', { method: 'GET' }, TIMEOUT_LONGO);
  const k = (insights && insights.kpis) || {};
  const base = (insights && insights.baseline) || BASELINE;

  let leads24 = null, leadsErro = null;
  try { leads24 = await contarLeads24h(req); } catch (e) { leadsErro = (e && e.message) || 'falha'; }

  const linhas = [];
  linhas.push('Período consolidado (desde 09/08/2026):');
  linhas.push('• Gasto: ' + brl(k.gasto));
  linhas.push('• Impressões: ' + inteiro(k.impressoes));
  linhas.push('• Cliques: ' + inteiro(k.cliques) + ' — CTR ' + pct(k.ctr) + variacao(k.ctr, base.ctr));
  linhas.push('• Leads: ' + inteiro(k.leads));
  linhas.push('• CPL: ' + (k.cpl === null || k.cpl === undefined ? 'sem leads no período' : brl(k.cpl) + variacao(k.cpl, base.cpl)));
  linhas.push('• CPM: ' + brl(k.cpm) + variacao(k.cpm, base.cpm));
  linhas.push('');
  linhas.push('Baseline pré-consolidação: gasto ' + brl(base.gasto) + ', CPM ' + brl(base.cpm) +
              ', CPL ' + brl(base.cpl) + ', ' + inteiro(base.leads) + ' leads, CTR ' + pct(base.ctr) + '.');
  linhas.push('');
  if (leads24) {
    linhas.push('Leads nas últimas 24h: ' + inteiro(leads24.novos) +
                (leads24.qualificados ? ' (' + inteiro(leads24.qualificados) + ' já qualificados)' : '') +
                ' — ' + inteiro(leads24.total) + ' no total do CRM.');
  } else {
    linhas.push('Leads nas últimas 24h: não foi possível consultar (' + leadsErro + ').');
  }
  if (insights && insights.kpis && insights.kpis.erro) linhas.push('\nAtenção: a coleta da Meta reportou "' + insights.kpis.erro + '".');

  const texto = linhas.join('\n');
  const notificacao = await registrar('resumo', 'Resumo diário — ' + dataBrasilia(), texto, { whatsapp: true });

  return {
    ok: true,
    kpis: {
      gasto: num(k.gasto), impressoes: num(k.impressoes), cliques: num(k.cliques),
      ctr: num(k.ctr), cpm: num(k.cpm), leads: num(k.leads),
      cpl: (k.cpl === null || k.cpl === undefined) ? null : num(k.cpl)
    },
    leads24h: leads24 ? leads24.novos : null,
    entregaWhatsapp: notificacao ? notificacao.entregaWhatsapp : null
  };
}

// ------------------------------------------------------------------ handler

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'método não permitido' });
  }

  const auth = req.headers['authorization'] || '';
  const porCron = !!process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET;
  const porPainel = !!process.env.PANEL_KEY && req.headers['x-panel-key'] === process.env.PANEL_KEY;
  if (!porCron && !porPainel) return res.status(401).json({ error: 'unauthorized' });

  const passos = {};

  try { passos.tokenInstagram = await passoToken(); }
  catch (e) { passos.tokenInstagram = { ok: false, erro: (e && e.message) || 'falha' }; }

  try { passos.snapshot = await passoSnapshot(req); }
  catch (e) { passos.snapshot = { ok: false, erro: (e && e.message) || 'falha' }; }

  try { passos.saude = await passoSaude(req); }
  catch (e) { passos.saude = { ok: false, erro: (e && e.message) || 'falha' }; }

  try { passos.resumo = await passoResumo(req); }
  catch (e) { passos.resumo = { ok: false, erro: (e && e.message) || 'falha' }; }

  console.log('cron diario:', JSON.stringify(passos));
  return res.status(200).json({ ok: true, disparadoPor: porCron ? 'cron' : 'painel', em: Date.now(), passos });
};

// CORS: permite o CRM Harpy (e dev local) consumir a API de outro domínio; trata o preflight
function cors(req, res) {
  const origin = req.headers.origin || '';
  if (/^https:\/\/(crm-harpy\.vercel\.app|www\.nicolastasso\.site)$/.test(origin) || /^http:\/\/localhost:\d+$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-panel-key, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}
