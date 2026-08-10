// Trilha de rastreabilidade do painel CRM — junta numa única linha do tempo:
// auditoria de ações aplicadas (meta/audit.json), decisões sobre recomendações
// (meta/recs.json), notificações (meta/notificacoes.json) e o último contato
// registrado pelo robô (meta/activity.json).
//
// GET /api/crm/atividade  (header obrigatório: x-panel-key)
// Resposta: { itens: [{ tipo, t, titulo, detalhe, erro? }], resumo: { acoes, decisoes, notificacoes }, total, truncado }
//
// Cada leitura tem try/catch próprio: blob ausente ou ilegível vira lista vazia,
// nunca derruba o endpoint.
//
// Variáveis de ambiente: PANEL_KEY, CRM_PREFIX, BLOB_READ_WRITE_TOKEN

const LIMITE = 100;

// ---- helpers de storage (Vercel Blob via REST) — endpoint somente leitura ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

// ---- tradução das ações aplicadas ----
const ACOES_LEGIVEIS = {
  pausar_anuncio: 'Anúncio pausado',
  ativar_anuncio: 'Anúncio ativado',
  pausar_conjunto: 'Conjunto pausado',
  ajustar_orcamento: 'Orçamento ajustado',
  nenhuma: 'Marcada como lida'
};

function brl(valor) {
  const p = (Math.round(valor * 100) / 100).toFixed(2).split('.');
  return 'R$ ' + p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + p[1];
}

// normaliza carimbos de tempo variados (ms, segundos, ISO) para epoch em ms
function paraMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
  if (typeof v === 'number') {
    if (!isFinite(v) || v <= 0) return null;
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  const n = Date.parse(v);
  return isNaN(n) ? null : n;
}

// a IA nomeia o alvo de formas diferentes — mesma tolerância do apply.js
function idDaAcao(params) {
  if (!params || typeof params !== 'object') return null;
  const bruto = params.id || params.adId || params.anuncioId || params.adsetId || params.conjuntoId;
  return bruto === null || bruto === undefined ? null : String(bruto);
}

function erroDoResultado(resultado) {
  if (!resultado || typeof resultado !== 'object') return null;
  if (resultado.error) {
    return typeof resultado.error === 'string' ? resultado.error : (resultado.error.message || 'erro na execução');
  }
  if (resultado.erro) return String(resultado.erro);
  if (resultado.ok === false) return String(resultado.detalhe || resultado.mensagem || 'ação não concluída');
  return null;
}

function descreverAcao(acao) {
  const a = (acao && typeof acao === 'object') ? acao : {};
  const tipo = String(a.tipo || 'nenhuma');
  let txt = ACOES_LEGIVEIS[tipo] || ('Ação registrada: ' + tipo);
  if (tipo === 'ajustar_orcamento') {
    const centavos = parseInt(a.params && a.params.lifetime_budget, 10);
    if (Number.isFinite(centavos)) txt += ' para ' + brl(centavos / 100);
  }
  const id = idDaAcao(a.params);
  if (id) txt += ' · id ' + id;
  return txt;
}

// ---- conversores de cada fonte para itens da linha do tempo ----

function itensDaAuditoria(auditoria) {
  if (!Array.isArray(auditoria)) return [];
  const out = [];
  for (const e of auditoria) {
    if (!e || typeof e !== 'object') continue;
    const recId = e.recId ? String(e.recId) : 'recomendação';
    const item = {
      tipo: 'acao',
      t: paraMs(e.t),
      titulo: 'Recomendação aplicada: ' + recId,
      detalhe: descreverAcao(e.acao)
    };
    const erro = erroDoResultado(e.resultado);
    if (erro) {
      item.erro = erro;
      item.detalhe = item.detalhe + ' — falhou: ' + erro;
    }
    out.push(item);
  }
  return out;
}

function itensDasDecisoes(recs) {
  if (!recs || typeof recs !== 'object' || Array.isArray(recs)) return [];
  const out = [];
  for (const id of Object.keys(recs)) {
    const estado = String(recs[id] || '');
    if (estado !== 'ignorada' && estado !== 'aplicada') continue;
    out.push({
      tipo: 'decisao',
      t: null, // o estado das recomendações não guarda data — vai para o fim da lista
      titulo: 'Recomendação ' + estado + ': ' + id,
      detalhe: estado === 'ignorada'
        ? 'Descartada no painel, sem execução na Meta.'
        : 'Marcada como aplicada no painel.'
    });
  }
  return out;
}

// o blob de notificações é escrito por outro módulo — aceitamos os formatos prováveis
function listaDeNotificacoes(bruto) {
  if (!bruto) return [];
  if (Array.isArray(bruto)) return bruto;
  if (Array.isArray(bruto.itens)) return bruto.itens;
  if (Array.isArray(bruto.notificacoes)) return bruto.notificacoes;
  if (Array.isArray(bruto.lista)) return bruto.lista;
  return [];
}

function itensDasNotificacoes(bruto) {
  const out = [];
  for (const n of listaDeNotificacoes(bruto)) {
    if (!n || typeof n !== 'object') continue;
    const titulo = String(n.titulo || n.texto || n.mensagem || 'Notificação');
    let detalhe = n.detalhe || n.descricao || '';
    if (!detalhe && n.titulo && (n.texto || n.mensagem)) detalhe = n.texto || n.mensagem;
    out.push({
      tipo: 'notificacao',
      t: paraMs(n.t !== undefined ? n.t : (n.criadoEm || n.data || n.quando)),
      titulo,
      detalhe: String(detalhe || '')
    });
  }
  return out;
}

function itensDoRobo(atividade) {
  if (!atividade || typeof atividade !== 'object') return [];
  const t = paraMs(atividade.t);
  if (t === null) return [];
  return [{
    tipo: 'robo',
    t,
    titulo: 'Última atividade do robô',
    detalhe: atividade.ultimo ? ('Último contato atendido: ' + String(atividade.ultimo)) : 'Atendimento automático registrado.'
  }];
}

// mais recente primeiro; itens sem data (decisões) por último, na ordem original
function porTempoDecrescente(a, b) {
  if (a.t === null && b.t === null) return 0;
  if (a.t === null) return 1;
  if (b.t === null) return -1;
  return b.t - a.t;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'metodo nao permitido' });

  try {
    let auditoria = null, recs = null, notificacoes = null, robo = null;

    await Promise.all([
      blobGet('meta/audit.json').then(d => { auditoria = d; }).catch(() => { auditoria = null; }),
      blobGet('meta/recs.json').then(d => { recs = d; }).catch(() => { recs = null; }),
      blobGet('meta/notificacoes.json').then(d => { notificacoes = d; }).catch(() => { notificacoes = null; }),
      blobGet('meta/activity.json').then(d => { robo = d; }).catch(() => { robo = null; })
    ]);

    const todos = []
      .concat(itensDaAuditoria(auditoria))
      .concat(itensDasNotificacoes(notificacoes))
      .concat(itensDoRobo(robo))
      .concat(itensDasDecisoes(recs));

    todos.sort(porTempoDecrescente);
    const itens = todos.slice(0, LIMITE);

    const resumo = { acoes: 0, decisoes: 0, notificacoes: 0 };
    for (const i of itens) {
      if (i.tipo === 'acao') resumo.acoes++;
      else if (i.tipo === 'decisao') resumo.decisoes++;
      else if (i.tipo === 'notificacao') resumo.notificacoes++;
    }

    return res.status(200).json({
      itens,
      resumo,
      total: todos.length,
      truncado: todos.length > itens.length,
      geradoEm: new Date().toISOString()
    });
  } catch (e) {
    console.error('atividade erro:', e.message);
    return res.status(500).json({ error: 'erro ao montar a atividade', detalhe: e.message });
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
