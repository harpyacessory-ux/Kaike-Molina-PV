// CRM — desempenho orgânico do Instagram (@nicolastassooficial) via Graph API.
// Lê perfil, últimos posts e métricas por publicação; agrega um resumo para o painel.
//
// GET /api/crm/instagram            → dados (cache de 15 min em Vercel Blob)
// GET /api/crm/instagram?forcar=1   → ignora o cache e recoleta da Graph API
// Auth: header 'x-panel-key' === process.env.PANEL_KEY
//
// PERMISSÕES: o token de system user (ADS_TOKEN) já lê o perfil, mas /media e /insights
// exigem os escopos instagram_basic e instagram_manage_insights. Enquanto eles não
// existirem, a Graph responde com erro código 10 ("Application does not have permission
// for this action") — nesse caso o endpoint NÃO quebra: devolve HTTP 200 com
// {conectado:false, precisaPermissao:true} e o painel mostra o aviso. Assim que o token
// ganhar os escopos, a próxima requisição já retorna os dados completos, sem deploy.
// (Por isso a resposta degradada nunca é cacheada.)
//
// Variáveis de ambiente: ADS_TOKEN, PANEL_KEY, CRM_PREFIX, BLOB_READ_WRITE_TOKEN
//
// TOKEN: não usa mais process.env.IG_TOKEN direto — lerToken() devolve o token vigente
// (o renovado no blob quando existir, senão a env). Depois de responder, o handler dispara
// renovarSePreciso(false) em segundo plano, para o token nunca chegar perto de expirar.

const { lerToken, renovarSePreciso } = require('../../lib/ig-token');

// Instagram API com login do Instagram: base própria e o token identifica a conta (/me).
const GRAPH = 'https://graph.instagram.com/v21.0';
const IG_ID = 'me';                       // conta @nicolastassooficial (dona do IG_TOKEN)
const CACHE_MS = 900000;                  // 15 minutos
const MAX_POSTS = 50;                     // posts buscados na listagem
const MAX_METRICAS = 25;                  // posts que recebem chamada de /insights
const LEGENDA_MAX = 180;

// ---- helpers de storage (Vercel Blob via REST) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

// ---- helper da Graph API (propaga o código do erro para detectar falta de permissão) ----
// TOKEN é preenchido uma única vez no começo do handler (lerToken) e usado por todas as
// chamadas da invocação; a env fica como último recurso.
let TOKEN = '';
async function graphGet(pathAndQuery) {
  const sep = pathAndQuery.indexOf('?') === -1 ? '?' : '&';
  const r = await fetch(GRAPH + pathAndQuery + sep + 'access_token=' + encodeURIComponent(TOKEN || process.env.IG_TOKEN || ''));
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) {
    const err = (d && d.error) || {};
    const e = new Error(err.message || ('graph http ' + r.status));
    e.code = err.code;
    e.subcode = err.error_subcode;
    throw e;
  }
  return d;
}

// erro de escopo/permissão: (#10) sem permissão para a ação, (#200) permissão ausente
function ehPermissao(e) {
  if (!e) return false;
  if (e.code === 10 || e.code === 200) return true;
  return /permission|permissão|escopo|scope/i.test(e.message || '');
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function r2(n) { return Math.round(n * 100) / 100; }

function trunc(s, n) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n).trim() + '…' : t;
}

// REELS aparece em media_product_type; media_type devolveria só VIDEO
function tipoDe(m) {
  if (m.media_product_type === 'REELS') return 'REELS';
  return m.media_type || 'DESCONHECIDO';
}

// /insights devolve [{name, values:[{value}]}] — achata em objeto simples
function mapMetricas(d) {
  const out = {};
  const arr = (d && d.data) || [];
  for (const m of arr) {
    const v = m.values && m.values[0] ? m.values[0].value : null;
    if (v !== null && v !== undefined && typeof v !== 'object') out[m.name] = num(v);
  }
  return out;
}

// métricas de um post. As métricas aceitas variam por tipo de mídia e posts antigos
// rejeitam algumas — daí o retry com o conjunto mínimo e a desistência silenciosa.
async function metricasPost(id) {
  try {
    return mapMetricas(await graphGet('/' + id + '/insights?metric=reach,saved,total_interactions,shares,comments,likes'));
  } catch (e1) {
    try {
      return mapMetricas(await graphGet('/' + id + '/insights?metric=reach,saved'));
    } catch (e2) {
      return null; // segue sem métricas para este post
    }
  }
}

// soma uma série diária de /insights da conta (period=day)
function somaSerie(d, nome) {
  const m = ((d && d.data) || []).find(x => x.name === nome);
  if (!m || !Array.isArray(m.values)) return null;
  return m.values.reduce((s, v) => s + num(v.value), 0);
}

function montarResumo(posts) {
  const tiposContagem = { IMAGE: 0, VIDEO: 0, CAROUSEL_ALBUM: 0, REELS: 0 };
  for (const p of posts) {
    if (tiposContagem[p.tipo] === undefined) tiposContagem[p.tipo] = 0;
    tiposContagem[p.tipo]++;
  }

  const comCurtidas = posts.filter(p => p.curtidas !== null);
  const comComentarios = posts.filter(p => p.comentarios !== null);
  const comAlcance = posts.filter(p => p.alcance !== null && p.alcance > 0);
  const comInteracoes = posts.filter(p => p.interacoes !== null);

  const somaCurtidas = comCurtidas.reduce((s, p) => s + p.curtidas, 0);
  const somaComentarios = comComentarios.reduce((s, p) => s + p.comentarios, 0);

  // melhor post: por interações quando houver métricas; senão, por curtidas
  const base = comInteracoes.length ? comInteracoes : comCurtidas;
  const chave = comInteracoes.length ? 'interacoes' : 'curtidas';
  let melhorPost = null;
  if (base.length) {
    const m = base.reduce((a, b) => (b[chave] > a[chave] ? b : a));
    melhorPost = { id: m.id, legenda: m.legenda };
    melhorPost[chave] = m[chave];
  }

  return {
    totalPosts: posts.length,
    somaCurtidas,
    somaComentarios,
    mediaCurtidas: comCurtidas.length ? r2(somaCurtidas / comCurtidas.length) : null,
    mediaComentarios: comComentarios.length ? r2(somaComentarios / comComentarios.length) : null,
    alcanceMedio: comAlcance.length ? Math.round(comAlcance.reduce((s, p) => s + p.alcance, 0) / comAlcance.length) : null,
    melhorPost,
    tiposContagem
  };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'método não permitido' });

  const q = req.query || {};
  const forcar = String(q.forcar || '') === '1' || /[?&]forcar=1/.test(req.url || '');

  try {
    // ---- cache (15 minutos) ----
    if (!forcar) {
      const cache = await blobGet('meta/instagram-cache.json').catch(() => null);
      if (cache && cache.t > Date.now() - CACHE_MS && cache.body) {
        return res.status(200).json(Object.assign({}, cache.body, { cacheado: true }));
      }
    }

    // ---- token vigente: uma leitura por invocação, usada por todas as chamadas ----
    // (fica depois do cache para a resposta cacheada não pagar por uma leitura de blob)
    TOKEN = await lerToken();

    // ---- perfil (já funciona com o token atual) ----
    let perfil = null, perfilErro = null;
    try {
      perfil = await graphGet('/' + IG_ID + '?fields=username,name,followers_count,follows_count,media_count,profile_picture_url,biography,website');
    } catch (e) {
      perfilErro = e.message;
    }

    // ---- posts ----
    let midias = [];
    try {
      const d = await graphGet('/' + IG_ID + '/media?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=' + MAX_POSTS);
      midias = (d && d.data) || [];
    } catch (e) {
      if (ehPermissao(e)) {
        // degrada com elegância: o painel mostra o perfil e o aviso de permissão
        return res.status(200).json({
          conectado: false,
          precisaPermissao: true,
          perfil,
          erro: e.message,
          posts: [],
          geradoEm: new Date().toISOString(),
          cacheado: false
        });
      }
      throw e;
    }

    // ---- métricas por post (paralelo, tolerante a falha individual) ----
    const alvos = midias.slice(0, MAX_METRICAS);
    const metricas = await Promise.all(alvos.map(m => metricasPost(m.id).catch(() => null)));
    const porId = {};
    alvos.forEach((m, i) => { if (metricas[i]) porId[m.id] = metricas[i]; });

    const posts = midias.map(m => {
      const mt = porId[m.id] || {};
      const alcance = mt.reach !== undefined ? mt.reach : null;
      const interacoes = mt.total_interactions !== undefined ? mt.total_interactions : null;
      return {
        id: m.id,
        legenda: trunc(m.caption, LEGENDA_MAX),
        tipo: tipoDe(m),
        thumb: m.thumbnail_url || m.media_url || null,
        permalink: m.permalink || null,
        data: m.timestamp || null,
        curtidas: m.like_count !== undefined ? num(m.like_count) : null,
        comentarios: m.comments_count !== undefined ? num(m.comments_count) : null,
        alcance,
        salvos: mt.saved !== undefined ? mt.saved : null,
        interacoes,
        compartilhamentos: mt.shares !== undefined ? mt.shares : null,
        taxaEngajamento: (interacoes > 0 && alcance > 0) ? r2((interacoes / alcance) * 100) : null
      };
    });

    // ---- insights da conta (opcional — some sem quebrar nada) ----
    let conta = null;
    try {
      const until = Math.floor(Date.now() / 1000);
      const since = until - 30 * 86400;
      const d = await graphGet('/' + IG_ID + '/insights?metric=reach,profile_views&period=day&since=' + since + '&until=' + until);
      const alcance30d = somaSerie(d, 'reach');
      const visitasPerfil30d = somaSerie(d, 'profile_views');
      if (alcance30d !== null || visitasPerfil30d !== null) {
        conta = { alcance30d, visitasPerfil30d };
      }
    } catch (e) { /* insights da conta são opcionais */ }

    const body = {
      conectado: true,
      perfil,
      posts,
      resumo: montarResumo(posts),
      conta,
      geradoEm: new Date().toISOString()
    };
    if (perfilErro) body.perfilErro = perfilErro;

    try { await blobPut('meta/instagram-cache.json', { t: Date.now(), body }); } catch (e) { /* cache é melhor-esforço */ }

    res.status(200).json(Object.assign({}, body, { cacheado: false }));

    // renovação em segundo plano: só age se o token guardado já passou de 7 dias.
    // Sem await e com .catch — jamais atrasa ou quebra a resposta já enviada.
    renovarSePreciso(false).catch(() => {});
    return;
  } catch (e) {
    console.error('instagram erro:', e.message);
    return res.status(500).json({ error: 'erro ao consultar o Instagram', detalhe: e.message });
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
