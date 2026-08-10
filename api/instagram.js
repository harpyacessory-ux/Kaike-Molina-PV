// Robô do Instagram (@nicolastassooficial) — responde COMENTÁRIOS e MENSAGENS DIRETAS com IA.
// Mesmo espírito do robô do WhatsApp (api/whatsapp.js): webhook público da Meta, dedupe de
// eventos, resposta gerada pelo Claude, persistência no Vercel Blob e HTTP 200 sempre.
//
// Este endpoint é PÚBLICO de propósito: quem autentica é a Meta (handshake + assinatura do app).
// Não use x-panel-key aqui — a Meta não envia esse header.
//
// Configuração do webhook (Meta → app → Instagram → Webhooks):
//   Callback URL:  https://<seu-dominio>/api/instagram
//   Verify token:  o mesmo valor de IG_VERIFY_TOKEN
//   Campos:        comments (comentários) e messages (direct)
//
// Variáveis de ambiente:
//   IG_TOKEN              token "Instagram Login" (prefixo IGAA) da conta @nicolastassooficial
//   IG_VERIFY_TOKEN       string combinada no painel da Meta para o handshake (opcional, recomendada)
//   IG_USER_ID            id da conta no Instagram (opcional — sem ele o robô descobre via GET /me)
//   ANTHROPIC_API_KEY     chave da API do Claude
//   CRM_PREFIX            prefixo das chaves no Vercel Blob
//   BLOB_READ_WRITE_TOKEN token de leitura/escrita do Vercel Blob
//
// O token do Instagram NUNCA é logado. Toda operação de Blob fica em try/catch e jamais
// impede a resposta ao lead nem a resposta HTTP à Meta.

// Instagram API com login do Instagram: base própria e o token identifica a conta (/me).
// O token vai SEMPRE por query param (?access_token=...), nunca como header Bearer.
const GRAPH = 'https://graph.instagram.com/v21.0';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 300;

// Renovação automática do token (módulo opcional). Se o arquivo não existir ou quebrar,
// o robô continua funcionando com o valor cru de process.env.IG_TOKEN.
let tokenMod = null;
try { tokenMod = require('../lib/ig-token'); } catch (e) { tokenMod = null; }

const SYSTEM_BASE = `Você é o assistente virtual da equipe do Nicolas Tasso — consultoria de marketing e marketplaces (nicolastasso.site). Você atende o público pelo Instagram (@nicolastassooficial) em português do Brasil.

SOBRE O NEGÓCIO
- Assessoria especializada em marketplaces: Mercado Livre, Shopee e Amazon, além de gestão de anúncios em Meta Ads e Google Ads.
- Mais de 800 contas gerenciadas nos marketplaces.
- O time cuida de posicionamento de anúncios, precificação, tráfego e otimização diária da conta, enquanto o cliente cuida do produto.
- Oferta principal: ANÁLISE GRATUITA DE POTENCIAL DE VENDAS — um especialista analisa a operação do lead e mostra onde há oportunidade de vender mais.
- Público: quem já vende em marketplace e quer escalar, ou quem quer começar a vender.

REGRAS GERAIS
- NUNCA invente preços, prazos, garantias ou resultados ("dobrar vendas", etc.). Se perguntarem valores, diga que depende do tamanho da operação e que o especialista apresenta as opções na análise gratuita — que não tem custo nem compromisso.
- Nunca peça dados sensíveis (senhas, cartão, documentos).
- Assuntos fora do tema (política, outros serviços, spam): redirecione com educação para marketplaces ou encerre.
- Se perguntarem se você é um robô, confirme com naturalidade: você é o assistente virtual da equipe, e um especialista humano assume em seguida.`;

const SYSTEM_DIRECT = SYSTEM_BASE + `

SEU OBJETIVO NO DIRECT (nesta ordem)
1. Dar boas-vindas e entender o contexto: pergunte se a pessoa já vende em marketplace e em qual (Mercado Livre, Shopee, Amazon, outro) ou se está começando.
2. Qualificar com UMA pergunta por vez (nunca despeje um questionário): faturamento mensal aproximado da operação; principal desafio hoje (vendas baixas, margem, anúncios, concorrência...).
3. Oferecer a análise gratuita e encaminhar: diga que um especialista do time vai assumir a conversa para agendar a análise.

FORMATO
- Mensagens curtas, estilo direct: no máximo 3 frases por resposta, uma pergunta por vez. No máximo 1 emoji por mensagem.
- Se a pessoa pedir para falar com um humano, ou já estiver qualificada, encerre avisando que o Nicolas ou alguém do time responde em breve por aqui mesmo.
- Se a mensagem for incompreensível, peça para a pessoa explicar de outra forma.`;

const SYSTEM_COMENTARIO = SYSTEM_BASE + `

SEU OBJETIVO NOS COMENTÁRIOS
Responder publicamente ao comentário de forma curta, simpática e humana, e convidar a pessoa a chamar no direct ou acessar o site nicolastasso.site para a análise gratuita.

FORMATO OBRIGATÓRIO
- No máximo 2 frases. No máximo 1 emoji.
- Nunca cite preços, prazos ou resultados garantidos.
- Se o comentário for elogio, agradeça e convide para o direct.
- Se for dúvida sobre marketplaces, responda em uma frase e convide para o direct.
- Se for crítica ou reclamação, seja educado, não discuta e chame para o direct resolver.
- Se for spam, ofensa ou algo sem relação, responda apenas com uma saudação breve e o convite para o direct.
- Escreva SOMENTE o texto da resposta, sem aspas e sem explicações.`;

const PADRAO_SEM_TEXTO = 'Consigo te ajudar melhor por mensagem de texto 🙂 Me conta: você já vende em algum marketplace (Mercado Livre, Shopee, Amazon) ou está começando?';

// memória curta por contato — dura enquanto a instância fica quente; suficiente para qualificação
const chats = new Map();
const nomes = new Map();
const seen = new Set();

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method === 'GET') {
    const q = req.query || {};
    // handshake de verificação da Meta: ecoa o desafio. A Meta às vezes verifica com o token
    // global do app (não o do override), então o eco é permissivo e a divergência é apenas logada.
    if (q['hub.mode'] === 'subscribe' && q['hub.challenge']) {
      if (process.env.IG_VERIFY_TOKEN && q['hub.verify_token'] !== process.env.IG_VERIFY_TOKEN) {
        console.log('instagram: verificacao com token diferente do esperado:', q['hub.verify_token']);
      }
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).send('forbidden');
  }

  if (req.method !== 'POST') return res.status(405).end();

  try {
    const entradas = (req.body && Array.isArray(req.body.entry)) ? req.body.entry : [];

    for (const entrada of entradas) {
      // ---- comentários (entry[].changes[] com field === 'comments') ----
      const mudancas = Array.isArray(entrada && entrada.changes) ? entrada.changes : [];
      for (const mudanca of mudancas) {
        if (!mudanca || mudanca.field !== 'comments') continue;
        const v = mudanca.value || {};
        if (!v.id || jaVisto('c:' + v.id)) continue;
        try {
          await tratarComentario(v);
        } catch (e) {
          console.error('instagram comentario erro:', e && e.message);
        }
      }

      // ---- mensagens diretas (entry[].messaging[]) ----
      const eventos = Array.isArray(entrada && entrada.messaging) ? entrada.messaging : [];
      for (const evento of eventos) {
        const msg = evento && evento.message;
        if (!msg) continue;                       // status de leitura/entrega: só confirmar
        if (msg.is_echo === true) continue;       // é a nossa própria mensagem
        const mid = msg.mid || (evento.sender && evento.sender.id) + ':' + (evento.timestamp || '');
        if (jaVisto('m:' + mid)) continue;
        try {
          await tratarDirect(evento);
        } catch (e) {
          console.error('instagram direct erro:', e && e.message);
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('instagram webhook error:', e && e.message);
    // 200 mesmo com erro, para a Meta não desativar o webhook por falhas repetidas
    return res.status(200).json({ ok: false });
  }
};

// dedupe de eventos repetidos (a Meta reenvia o mesmo webhook várias vezes)
function jaVisto(chave) {
  if (seen.has(chave)) return true;
  seen.add(chave);
  if (seen.size > 1000) seen.clear();
  return false;
}

// ---------------------------------------------------------------- comentários

async function tratarComentario(v) {
  const id = String(v.id);
  const texto = String((v.text || '')).trim();
  const autorId = v.from && v.from.id ? String(v.from.id) : '';
  const autor = (v.from && v.from.username) || '';
  const midiaId = (v.media && v.media.id) ? String(v.media.id) : '';

  // IGNORAR comentários da própria conta — senão o robô responde a si mesmo em loop
  const meu = await idDaConta();
  if (meu && autorId && autorId === meu) return;
  if (!texto) return;

  const contexto = 'Comentário de @' + (autor || 'usuário') + ' em uma publicação: "' + texto + '"\n\nEscreva a resposta pública ao comentário.';
  const resposta = await claude([{ role: 'user', content: contexto }], SYSTEM_COMENTARIO);

  await responderComentario(id, resposta);

  // registro no Blob — falha aqui nunca impede a resposta
  try {
    await blobPut('ig/comentarios/' + id + '.json', {
      id: id,
      texto: texto,
      autor: autor,
      midiaId: midiaId,
      resposta: resposta,
      t: Date.now()
    });
  } catch (e) { console.error('blob comentario fail:', e && e.message); }

  console.log(JSON.stringify({ canal: 'instagram', tipo: 'comentario', id: id, autor: autor, texto: texto, resposta: resposta }));
}

async function responderComentario(commentId, texto) {
  const t = await tokenAtual();
  const url = GRAPH + '/' + encodeURIComponent(commentId) + '/replies?access_token=' + encodeURIComponent(t);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'message=' + encodeURIComponent(texto)
  });
  if (!r.ok) console.error('instagram reply fail:', r.status, await r.text());
}

// ------------------------------------------------------------ direct (DM)

async function tratarDirect(evento) {
  const sender = evento.sender && evento.sender.id ? String(evento.sender.id) : '';
  if (!sender) return;

  const meu = await idDaConta();
  if (meu && sender === meu) return; // segurança extra além do is_echo

  const texto = String((evento.message && evento.message.text) || '').trim();
  if (!texto) {
    // anexos, figurinhas, áudios: pede texto e encerra
    await enviarDirect(sender, PADRAO_SEM_TEXTO);
    return;
  }

  const leadId = 'ig-' + sender;
  const nome = await nomeDe(sender);
  const now = Date.now();

  let chat = chats.get(sender);
  if (!chat || now - chat.t > 2 * 60 * 60 * 1000) {
    chat = { turns: [], full: [], nome: '', criadoEm: null, status: null };
    // sem histórico em RAM: tenta hidratar do Blob (falha aqui não impede a resposta)
    try {
      const lead = await blobGet('leads/' + leadId + '.json');
      if (lead && Array.isArray(lead.turns)) {
        chat.full = lead.turns.slice();
        // só os últimos 12 turns vão para o Claude, e sem o campo t
        chat.turns = lead.turns.slice(-12).map(function (t) { return { role: t.role, content: t.content }; });
        chat.nome = lead.nome || '';
        chat.criadoEm = lead.criadoEm || null;
        chat.status = lead.status || null;
      }
    } catch (e) { console.error('blob hydrate fail:', e && e.message); }
  }
  chat.t = now;
  chat.turns.push({ role: 'user', content: texto });
  chat.turns = chat.turns.slice(-12);
  chat.full.push({ role: 'user', content: texto, t: now });

  const apelido = nome || chat.nome || '';
  const resposta = await claude(chat.turns, SYSTEM_DIRECT + (apelido ? '\n\nUsuário do Instagram: @' + apelido : ''));

  chat.turns.push({ role: 'assistant', content: resposta });
  chat.full.push({ role: 'assistant', content: resposta, t: Date.now() });
  if (/humano|atendente|pessoa de verdade/i.test(texto) || /especialista|assumir|equipe (vai|entra)/i.test(resposta)) chat.status = 'qualificado';
  else if (!chat.status) chat.status = 'em_conversa';
  chats.set(sender, chat);
  if (chats.size > 500) chats.clear();

  await enviarDirect(sender, resposta);

  // persiste no Blob DEPOIS de responder — no mesmo formato do robô do WhatsApp,
  // para as conversas do Instagram aparecerem na aba Leads do painel.
  try {
    const agora = Date.now();
    if (!chat.criadoEm) chat.criadoEm = agora;
    await blobPut('leads/' + leadId + '.json', {
      id: leadId,
      nome: apelido,
      turns: chat.full,
      criadoEm: chat.criadoEm,
      atualizadoEm: agora,
      status: chat.status,
      canal: 'instagram'
    });
    await blobPut('meta/activity.json', { t: agora, ultimo: leadId });
  } catch (e) { console.error('blob persist fail:', e && e.message); }

  console.log(JSON.stringify({ canal: 'instagram', tipo: 'direct', lead: leadId, nome: apelido, msg: texto, resposta: resposta }));
}

async function enviarDirect(recipientId, texto) {
  const t = await tokenAtual();
  const url = GRAPH + '/me/messages?access_token=' + encodeURIComponent(t);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text: texto } })
  });
  if (!r.ok) console.error('instagram send fail:', r.status, await r.text());
}

// ------------------------------------------------------------------- Claude

async function claude(turns, system) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: system,
      messages: turns
    })
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()));
  const d = await r.json();
  const out = (d.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
  return out || 'Me chama no direct que a gente te ajuda! 🙌';
}

// ------------------------------------------------------- token e identidade

// Usa o módulo de renovação quando ele existir; senão cai no token cru da env.
// O valor retornado NUNCA é logado.
async function tokenAtual() {
  if (tokenMod) {
    const fn = (typeof tokenMod === 'function' && tokenMod)
      || tokenMod.getToken || tokenMod.obterToken || tokenMod.token
      || tokenMod.tokenAtual || tokenMod.getIgToken || tokenMod.default;
    if (typeof fn === 'function') {
      try {
        const t = await fn();
        if (t && typeof t === 'string') return t;
        if (t && typeof t === 'object' && typeof t.access_token === 'string') return t.access_token;
      } catch (e) { console.error('ig-token fail:', e && e.message); }
    }
  }
  return process.env.IG_TOKEN || '';
}

async function igGet(pathAndQuery) {
  const t = await tokenAtual();
  const sep = pathAndQuery.indexOf('?') === -1 ? '?' : '&';
  const r = await fetch(GRAPH + pathAndQuery + sep + 'access_token=' + encodeURIComponent(t));
  const d = await r.json().catch(function () { return null; });
  if (!r.ok || !d || d.error) {
    const err = (d && d.error) || {};
    throw new Error(err.message || ('graph http ' + r.status));
  }
  return d;
}

// id da conta @nicolastassooficial — usado para ignorar os próprios comentários/mensagens
let contaId = null;
async function idDaConta() {
  if (process.env.IG_USER_ID) return String(process.env.IG_USER_ID);
  if (contaId) return contaId;
  try {
    const d = await igGet('/me?fields=id');
    if (d && d.id) contaId = String(d.id);
  } catch (e) { console.error('instagram /me fail:', e && e.message); }
  return contaId;
}

// @username de quem mandou o direct (opcional — some sem quebrar nada)
async function nomeDe(senderId) {
  if (nomes.has(senderId)) return nomes.get(senderId);
  let nome = '';
  try {
    const d = await igGet('/' + encodeURIComponent(senderId) + '?fields=username');
    nome = (d && (d.username || d.name)) || '';
  } catch (e) { /* perfil do remetente é opcional */ }
  nomes.set(senderId, nome);
  if (nomes.size > 500) nomes.clear();
  return nome;
}

// ---- memória persistente no Vercel Blob (sobrevive a instâncias frias) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

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
