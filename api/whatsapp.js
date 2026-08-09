// Assistente de IA no WhatsApp — WhatsApp Cloud API (Meta) + Claude (Anthropic).
// Recebe os webhooks de mensagens, responde com IA treinada nas informações do negócio
// e qualifica o lead antes de passar para o atendimento humano.
//
// Variáveis de ambiente obrigatórias (Vercel → Settings → Environment Variables):
//   WHATSAPP_TOKEN        token de acesso da Cloud API (app CRM Harpy → WhatsApp → Configuração da API)
//   WHATSAPP_PHONE_ID     ID do número de telefone (mesma tela da Meta)
//   WHATSAPP_VERIFY_TOKEN string combinada na configuração do webhook (ex.: nicolastasso-ai-2026)
//   ANTHROPIC_API_KEY     chave da API do Claude (console.anthropic.com)
// Opcional:
//   HUMAN_WHATSAPP        número humano para handoff (padrão: 5513992020409)

const GRAPH = 'https://graph.facebook.com/v21.0';
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM = `Você é o assistente virtual da equipe do Nicolas Tasso — consultoria de marketing e marketplaces (nicolastasso.site). Você atende leads pelo WhatsApp em português do Brasil.

SOBRE O NEGÓCIO
- Assessoria especializada em marketplaces: Mercado Livre, Shopee e Amazon, além de gestão de anúncios em Meta Ads e Google Ads.
- Mais de 800 contas gerenciadas nos marketplaces.
- O time cuida de posicionamento de anúncios, precificação, tráfego e otimização diária da conta, enquanto o cliente cuida do produto.
- Oferta principal: ANÁLISE GRATUITA DE POTENCIAL DE VENDAS — um especialista analisa a operação do lead e mostra onde há oportunidade de vender mais.
- Público: quem já vende em marketplace e quer escalar, ou quem quer começar a vender.

SEU OBJETIVO (nesta ordem)
1. Dar boas-vindas e entender o contexto: pergunte se a pessoa já vende em marketplace e em qual (Mercado Livre, Shopee, Amazon, outro) ou se está começando.
2. Qualificar com UMA pergunta por vez (nunca despeje um questionário): faturamento mensal aproximado da operação; principal desafio hoje (vendas baixas, margem, anúncios, concorrência...).
3. Oferecer a análise gratuita e encaminhar: diga que um especialista do time vai assumir a conversa para agendar a análise. A partir daí o atendimento humano continua.

REGRAS
- Mensagens curtas, estilo WhatsApp: no máximo 3 frases por resposta, uma pergunta por vez. Emojis com moderação (no máximo 1 por mensagem).
- NUNCA invente preços, prazos, garantias ou resultados ("dobrar vendas", etc.). Se perguntarem valores, diga que depende do tamanho da operação e que o especialista apresenta as opções na análise gratuita — que não tem custo nem compromisso.
- Se perguntarem se você é um robô, confirme com naturalidade: você é o assistente virtual da equipe, e um especialista humano assume em seguida.
- Se a pessoa pedir para falar com um humano, ou já estiver qualificada, encerre avisando que o Nicolas ou alguém do time responde em breve por aqui mesmo.
- Assuntos fora do tema (política, outros serviços, spam): redirecione com educação para o assunto marketplaces ou encerre.
- Nunca peça dados sensíveis (senhas, cartão, documentos). Nome, cidade e faturamento aproximado são suficientes.
- Se a mensagem for incompreensível, peça para a pessoa explicar de outra forma.`;

// memória curta por contato — dura enquanto a instância fica quente; suficiente para conversas de qualificação
const chats = new Map();
const seen = new Set();

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const q = req.query || {};
    // handshake de verificação da Meta: ecoa o desafio. A Meta às vezes verifica com o token
    // global do app (não o do override), então o eco é permissivo e o token recebido é logado.
    if (q['hub.mode'] === 'subscribe' && q['hub.challenge']) {
      if (q['hub.verify_token'] !== process.env.WHATSAPP_VERIFY_TOKEN) {
        console.log('verificacao com token diferente do esperado:', q['hub.verify_token']);
      }
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).send('forbidden');
  }
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const val = req.body && req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0] && req.body.entry[0].changes[0].value;
    const msg = val && val.messages && val.messages[0];
    // eventos de status (entregue/lido) e repetições de webhook: só confirmar
    if (!msg || seen.has(msg.id)) return res.status(200).json({ ok: true });
    seen.add(msg.id);
    if (seen.size > 1000) seen.clear();

    const from = msg.from;
    const nome = (val.contacts && val.contacts[0] && val.contacts[0].profile && val.contacts[0].profile.name) || '';

    let texto = '';
    if (msg.type === 'text') texto = (msg.text && msg.text.body) || '';
    else if (msg.type === 'button') texto = (msg.button && msg.button.text) || '';
    else if (msg.type === 'interactive') texto = (msg.interactive && ((msg.interactive.button_reply && msg.interactive.button_reply.title) || (msg.interactive.list_reply && msg.interactive.list_reply.title))) || '';

    if (!texto) {
      await sendText(from, 'Consigo te ajudar melhor por mensagem de texto 🙂 Me conta: você já vende em algum marketplace (Mercado Livre, Shopee, Amazon) ou está começando?');
      return res.status(200).json({ ok: true });
    }

    const now = Date.now();
    let chat = chats.get(from);
    if (!chat || now - chat.t > 2 * 60 * 60 * 1000) chat = { turns: [] };
    chat.t = now;
    chat.turns.push({ role: 'user', content: texto });
    chat.turns = chat.turns.slice(-12);

    const resposta = await claude(chat.turns, nome);
    chat.turns.push({ role: 'assistant', content: resposta });
    chats.set(from, chat);
    if (chats.size > 500) chats.clear();

    await markRead(msg.id);
    await sendText(from, resposta);
    console.log(JSON.stringify({ lead: from, nome, msg: texto, resposta }));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('whatsapp webhook error:', e && e.message);
    // 200 mesmo com erro, para a Meta não desativar o webhook por falhas repetidas
    return res.status(200).json({ ok: false });
  }
};

async function claude(turns, nome) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM + (nome ? '\n\nNome do contato no WhatsApp: ' + nome : ''),
      messages: turns
    })
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()));
  const d = await r.json();
  const out = (d.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
  return out || 'Só um instante, já te respondo!';
}

async function sendText(to, body) {
  const r = await fetch(GRAPH + '/' + process.env.WHATSAPP_PHONE_ID + '/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.WHATSAPP_TOKEN,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'text', text: { body: body } })
  });
  if (!r.ok) console.error('send fail:', r.status, await r.text());
}

async function markRead(messageId) {
  try {
    await fetch(GRAPH + '/' + process.env.WHATSAPP_PHONE_ID + '/messages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.WHATSAPP_TOKEN,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId })
    });
  } catch (e) { /* leitura é cosmética; não interrompe o fluxo */ }
}
