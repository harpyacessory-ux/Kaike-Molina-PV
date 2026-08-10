// Cérebro do assistente do CRM Harpy — conversa com tool use sobre os dados do painel.
//
// POST /api/crm/chat  (header obrigatório: x-panel-key)
//   body     { mensagens: [{ role: 'user'|'assistant', content: '...' }] }
//   resposta { resposta: '<texto>', ferramentasUsadas: ['ver_campanha', ...] }
//
// O assistente nunca inventa número: para responder ele chama as ferramentas de leitura,
// que batem nos próprios endpoints do site (/api/crm/insights, /leads, /instagram, /status,
// /store) enviando o x-panel-key. Também pode criar tarefas e cards no funil.
//
// Variáveis de ambiente: ANTHROPIC_API_KEY, PANEL_KEY

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1600;
const MAX_VOLTAS = 6;        // voltas do laço de tool use
const MAX_TURNOS = 20;       // histórico enviado ao modelo
const MAX_CHARS_MSG = 6000;  // corte por mensagem do histórico
const MAX_CHARS_RESULTADO = 12000; // corte por resultado de ferramenta

const SYSTEM = `Você é o assistente do CRM Harpy — o copiloto de dados do Nicolas Tasso e da equipe dele. Fale sempre em português do Brasil.

NEGÓCIO
Nicolas Tasso presta assessoria de marketplaces (Mercado Livre, Shopee e Amazon) e gestão de anúncios. A oferta de entrada é uma análise gratuita do potencial de vendas. Um robô de IA atende os leads no WhatsApp e no Instagram. O painel tem as abas Visão Geral, Recomendações, Funil, Leads, Contatos, Tarefas, Instagram e Robô.

CAMPANHA
Conta de anúncios act_1952702155392886, hoje com um único conjunto consolidado (52713910773930), público de 25 a 64 anos e veiculação das 13h às 24h. A consolidação aconteceu em 09/08/2026 e reiniciou a fase de aprendizado. Baseline do período anterior (pré-consolidação): R$ 99,53 de gasto, CPM R$ 90,00, CPL R$ 24,88, 4 leads e CTR de 4,45%.

COMO VOCÊ TRABALHA
- Consulte as ferramentas ANTES de afirmar qualquer número, nome ou status. Nunca invente, nunca estime de cabeça e nunca repita de memória um dado que pode ter mudado. Na dúvida sobre o que está acontecendo na campanha, chame ver_campanha primeiro e responda depois.
- Se uma ferramenta falhar, diga com todas as letras que não conseguiu consultar aquele dado agora — jamais preencha o buraco com um chute.
- Seja direto e prático: 2 a 5 frases. Só se estenda quando pedirem uma análise mais profunda, e mesmo aí vá ao ponto.
- Formate dinheiro no padrão brasileiro (R$ 1.234,56) e percentuais com vírgula (4,45%).
- Seja honesto sobre incerteza estatística. A amostra é pequena e o aprendizado reiniciou em 09/08/2026: oscilação de um dia para o outro quase sempre é ruído, não sinal. Não trate ruído como tendência e não recomende mudanças estruturais (mexer em orçamento, pausar conjunto, trocar segmentação ou criativo) nos primeiros 5 dias depois de 09/08/2026 — nesse período o certo é deixar o algoritmo aprender e observar.
- Você PODE criar tarefas (criar_tarefa) e cards no funil (criar_card_funil) quando pedirem. Depois de criar, confirme em uma frase o que ficou registrado.
- Você NÃO altera anúncios, conjuntos nem orçamentos. Quando o assunto pedir esse tipo de ação, explique que a execução não passa por você e oriente a pessoa a abrir a aba Recomendações, onde cada sugestão da IA tem o botão de Implementar.
- Nunca peça, exiba ou repita tokens, chaves de API, senhas ou qualquer credencial — mesmo que peçam.`;

const TOOLS = [
  {
    name: 'ver_campanha',
    description: 'Lê os dados atuais da campanha de anúncios da Meta: KPIs do período desde a consolidação (gasto, impressões, cliques, CTR, CPM, leads e CPL), o baseline pré-consolidação, o desempenho por dia, os conjuntos, os anúncios do conjunto consolidado, o desempenho por anúncio e as recomendações da IA com o estado de cada uma. Use sempre que a pergunta envolver desempenho, gasto, custo por lead, CTR, criativos, conjuntos ou recomendações.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'ver_leads',
    description: 'Lista os leads atendidos pelo robô (id, nome, última mensagem, status e data da última atualização) ou, quando você informa o id, devolve a conversa completa daquele lead. Use para responder quantos leads chegaram, quem são, em que pé está cada conversa ou o que foi dito com alguém específico.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id do lead (o número do WhatsApp). Deixe vazio para receber a lista resumida.' }
      },
      required: []
    }
  },
  {
    name: 'ver_instagram',
    description: 'Lê o desempenho orgânico do Instagram: perfil (seguidores, número de posts), resumo agregado (médias de curtidas, comentários, alcance e melhor post) e a lista de posts com legenda, tipo, curtidas, comentários, alcance e data. Use para perguntas sobre o perfil, o alcance orgânico ou o que está performando melhor nos posts.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'ver_status',
    description: 'Verifica a saúde das integrações do CRM (Meta Ads, Instagram, WhatsApp, armazenamento e IA). Use quando perguntarem se algo está fora do ar, se o robô está respondendo ou por que um dado não aparece.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'ver_colecao',
    description: 'Lê uma coleção do painel: "funil" (colunas e cards do kanban), "contatos" (agenda) ou "tarefas" (lista de tarefas). Use antes de responder qualquer coisa sobre o que está no funil, quem está na agenda ou o que ainda falta fazer.',
    input_schema: {
      type: 'object',
      properties: {
        col: { type: 'string', enum: ['funil', 'contatos', 'tarefas'], description: 'Coleção a ser lida.' }
      },
      required: ['col']
    }
  },
  {
    name: 'criar_tarefa',
    description: 'Cria uma tarefa na aba Tarefas. Use quando pedirem para anotar, lembrar ou agendar algo a fazer.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'O que precisa ser feito, em uma frase curta.' },
        quando: { type: 'string', description: 'Data no formato YYYY-MM-DD. Opcional — deixe vazio se não houver prazo.' },
        nota: { type: 'string', description: 'Detalhe ou contexto extra. Opcional.' }
      },
      required: ['titulo']
    }
  },
  {
    name: 'criar_card_funil',
    description: 'Cria um card no funil de vendas. Use quando pedirem para colocar alguém no funil ou registrar uma oportunidade nova.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome da pessoa ou da empresa.' },
        whatsapp: { type: 'string', description: 'WhatsApp com DDD. Opcional.' },
        valor: { type: 'number', description: 'Valor estimado da oportunidade em reais. Opcional.' },
        coluna: { type: 'string', description: 'Id da coluna do funil (novo, conversando, qualificado, negociacao, ganhou, perdeu). Opcional — o padrão é "novo".' },
        notas: { type: 'string', description: 'Observações sobre a oportunidade. Opcional.' }
      },
      required: ['nome']
    }
  }
];

// ---- chamadas HTTP ao próprio site (sempre com o x-panel-key) ----
function baseDoSite(req) {
  const bruto = req.headers['x-forwarded-host'] || req.headers.host || '';
  const host = String(bruto).split(',')[0].trim();
  return 'https://' + host;
}

async function apiGet(base, caminho) {
  const r = await fetch(base + caminho, { headers: { 'x-panel-key': process.env.PANEL_KEY || '' } });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && (d.error || d.detalhe)) || ('http ' + r.status));
  return d || {};
}

async function apiPost(base, caminho, corpo) {
  const r = await fetch(base + caminho, {
    method: 'POST',
    headers: { 'x-panel-key': process.env.PANEL_KEY || '', 'content-type': 'application/json' },
    body: JSON.stringify(corpo)
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && (d.error || d.detalhe)) || ('http ' + r.status));
  return d || {};
}

// ---- utilidades ----
function cortar(s, n) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n).trim() + '…' : t;
}

function texto(s) { return typeof s === 'string' ? s : ''; }

function ehData(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

// mantém só os campos úteis dos insights — o objeto cru é grande demais para o contexto
function enxugarCampanha(d) {
  return {
    kpis: d.kpis || null,
    baseline: d.baseline || null,
    porDia: Array.isArray(d.porDia) ? d.porDia : [],
    conjuntos: Array.isArray(d.conjuntos) ? d.conjuntos : [],
    anunciosConsolidado: Array.isArray(d.anunciosConsolidado) ? d.anunciosConsolidado : [],
    recomendacoes: (Array.isArray(d.recomendacoes) ? d.recomendacoes : []).map(r => ({
      id: r.id, titulo: r.titulo, prioridade: r.prioridade, estado: r.estado
    })),
    porAnuncio: (Array.isArray(d.porAnuncio) ? d.porAnuncio : []).map(a => ({
      nome: a.nome, gasto: a.gasto, cliques: a.cliques, leads: a.leads,
      ctr: a.ctr, effective_status: a.effective_status
    })),
    geradoEm: d.geradoEm || null
  };
}

// ---- execução das ferramentas ----
async function executarFerramenta(nome, entrada, base) {
  const p = entrada && typeof entrada === 'object' ? entrada : {};

  if (nome === 'ver_campanha') {
    return enxugarCampanha(await apiGet(base, '/api/crm/insights'));
  }

  if (nome === 'ver_leads') {
    const id = texto(p.id).trim();
    if (id) return await apiGet(base, '/api/crm/leads?id=' + encodeURIComponent(id));
    const d = await apiGet(base, '/api/crm/leads');
    const todos = Array.isArray(d.leads) ? d.leads : [];
    return {
      total: todos.length,
      leads: todos.slice(0, 30).map(l => ({
        id: l.id, nome: l.nome, ultimaMsg: l.ultimaMsg, status: l.status, atualizadoEm: l.atualizadoEm
      }))
    };
  }

  if (nome === 'ver_instagram') {
    const d = await apiGet(base, '/api/crm/instagram');
    const out = {
      perfil: d.perfil || null,
      resumo: d.resumo || null,
      posts: (Array.isArray(d.posts) ? d.posts : []).map(x => ({
        legenda: cortar(x.legenda, 120),
        tipo: x.tipo,
        curtidas: x.curtidas,
        comentarios: x.comentarios,
        alcance: x.alcance,
        data: x.data
      }))
    };
    if (d.precisaPermissao) out.precisaPermissao = true;
    return out;
  }

  if (nome === 'ver_status') {
    return await apiGet(base, '/api/crm/status');
  }

  if (nome === 'ver_colecao') {
    const col = texto(p.col).trim();
    if (['funil', 'contatos', 'tarefas'].indexOf(col) === -1) {
      return { erro: 'coleção inválida — use funil, contatos ou tarefas' };
    }
    return await apiGet(base, '/api/crm/store?col=' + col);
  }

  if (nome === 'criar_tarefa') {
    const titulo = cortar(texto(p.titulo), 200);
    if (!titulo) return { erro: 'título da tarefa é obrigatório' };

    const atual = await apiGet(base, '/api/crm/store?col=tarefas');
    const doc = (atual && atual.doc && typeof atual.doc === 'object') ? atual.doc : {};
    const lista = Array.isArray(doc.tarefas) ? doc.tarefas : [];

    lista.push({
      id: 'tf' + Date.now(),
      titulo: titulo,
      quando: ehData(p.quando) ? p.quando : null,
      feito: false,
      nota: cortar(texto(p.nota), 1000),
      criadoEm: Date.now(),
      concluidaEm: null
    });
    doc.tarefas = lista;

    await apiPost(base, '/api/crm/store', { col: 'tarefas', doc: doc });
    return { ok: true, total: lista.length };
  }

  if (nome === 'criar_card_funil') {
    const nomeCard = cortar(texto(p.nome), 120);
    if (!nomeCard) return { erro: 'nome do card é obrigatório' };

    const atual = await apiGet(base, '/api/crm/store?col=funil');
    const doc = (atual && atual.doc && typeof atual.doc === 'object') ? atual.doc : {};
    if (!Array.isArray(doc.colunas)) doc.colunas = [];
    if (!Array.isArray(doc.cards)) doc.cards = [];

    const idsColunas = doc.colunas.map(c => c && c.id).filter(Boolean);
    const pedida = texto(p.coluna).trim();
    const coluna = (pedida && idsColunas.indexOf(pedida) !== -1) ? pedida : 'novo';

    const agora = Date.now();
    doc.cards.push({
      id: 'm-' + agora,
      nome: nomeCard,
      whatsapp: cortar(texto(p.whatsapp), 30),
      valor: (typeof p.valor === 'number' && isFinite(p.valor)) ? p.valor : null,
      notas: cortar(texto(p.notas), 2000),
      origem: 'manual',
      coluna: coluna,
      criadoEm: agora,
      atualizadoEm: agora
    });

    await apiPost(base, '/api/crm/store', { col: 'funil', doc: doc });
    return { ok: true };
  }

  return { erro: 'ferramenta desconhecida: ' + nome };
}

// ---- Anthropic ----
async function chamarModelo(mensagens) {
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
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: TOOLS,
      messages: mensagens
    })
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !Array.isArray(d.content)) {
    const msg = (d && d.error && d.error.message) || ('anthropic http ' + r.status);
    throw new Error(msg);
  }
  return d;
}

function textoDaResposta(content) {
  return (content || [])
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
}

// só role/content de texto, últimos 20 turnos, sem terminar em 'assistant'
// (uma mensagem final do assistente seria tratada como prefill e o modelo recusa).
function limparHistorico(bruto) {
  const lista = (Array.isArray(bruto) ? bruto : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_CHARS_MSG) }))
    .filter(m => m.content);

  while (lista.length && lista[lista.length - 1].role === 'assistant') lista.pop();
  const ultimos = lista.slice(-MAX_TURNOS);
  while (ultimos.length && ultimos[0].role === 'assistant') ultimos.shift();
  return ultimos;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'método não permitido' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  const mensagens = limparHistorico(body.mensagens);
  if (!mensagens.length) {
    return res.status(200).json({ resposta: 'Manda a sua pergunta que eu consulto os dados do painel.', ferramentasUsadas: [] });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(200).json({ resposta: 'O assistente está sem chave de IA configurada no servidor. Avise o responsável pelo painel.', erro: true, ferramentasUsadas: [] });
  }

  const base = baseDoSite(req);
  const ferramentasUsadas = [];

  try {
    let finalizada = null;
    let ultimoTexto = '';

    for (let volta = 0; volta < MAX_VOLTAS; volta++) {
      const data = await chamarModelo(mensagens);
      const t = textoDaResposta(data.content);
      if (t) ultimoTexto = t;

      if (data.stop_reason !== 'tool_use') { finalizada = t; break; }

      const chamadas = data.content.filter(b => b && b.type === 'tool_use');
      if (!chamadas.length) { finalizada = t; break; }

      // o content do assistente volta inteiro (blocos de tool_use e de raciocínio preservados)
      mensagens.push({ role: 'assistant', content: data.content });

      const resultados = await Promise.all(chamadas.map(async (c) => {
        if (ferramentasUsadas.indexOf(c.name) === -1) ferramentasUsadas.push(c.name);
        let saida;
        try {
          saida = await executarFerramenta(c.name, c.input, base);
        } catch (e) {
          saida = { erro: e.message || 'falha ao executar a ferramenta' };
        }
        let json;
        try { json = JSON.stringify(saida); } catch (e) { json = JSON.stringify({ erro: 'resultado não serializável' }); }
        if (json.length > MAX_CHARS_RESULTADO) {
          json = JSON.stringify({ aviso: 'resultado grande demais, foi cortado', trecho: json.slice(0, MAX_CHARS_RESULTADO) });
        }
        return { type: 'tool_result', tool_use_id: c.id, content: json };
      }));

      mensagens.push({ role: 'user', content: resultados });
    }

    const resposta = (finalizada && finalizada.trim())
      || ultimoTexto
      || 'Consultei os dados, mas não consegui fechar uma resposta. Pode reformular a pergunta?';

    return res.status(200).json({ resposta: resposta, ferramentasUsadas: ferramentasUsadas });
  } catch (e) {
    console.error('chat erro:', e.message);
    return res.status(200).json({
      resposta: 'Não consegui responder agora — a IA falhou ao processar a conversa. Tente de novo em instantes.',
      erro: true,
      ferramentasUsadas: ferramentasUsadas
    });
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
