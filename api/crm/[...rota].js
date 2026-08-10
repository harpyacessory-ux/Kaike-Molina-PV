// Roteador único de /api/crm/* — uma função serverless no lugar de treze.
//
// O plano da Vercel limita o número de funções por deploy, então cada rota
// deixou de ser um arquivo em api/ e virou um módulo em lib/crm/. Este arquivo
// é o único ponto de entrada: lê o primeiro segmento do caminho e delega ao
// handler correspondente, que continua sendo um (req, res) comum — nenhum
// deles precisou mudar de formato.
//
// /api/crm/insights → lib/crm/insights.js, /api/crm/store → lib/crm/store.js, etc.

const rotas = {
  apply: require('../../lib/crm/apply'),
  atividade: require('../../lib/crm/atividade'),
  chat: require('../../lib/crm/chat'),
  cron: require('../../lib/crm/cron'),
  historico: require('../../lib/crm/historico'),
  'ig-refresh': require('../../lib/crm/ig-refresh'),
  insights: require('../../lib/crm/insights'),
  instagram: require('../../lib/crm/instagram'),
  lead: require('../../lib/crm/lead'),
  leads: require('../../lib/crm/leads'),
  notificacoes: require('../../lib/crm/notificacoes'),
  snapshot: require('../../lib/crm/snapshot'),
  status: require('../../lib/crm/status'),
  store: require('../../lib/crm/store')
};

module.exports = async (req, res) => {
  // o nome da rota vem do catch-all (req.query.rota); o caminho da URL é o reserva
  let nome = '';
  const q = (req.query && req.query.rota) || null;
  if (Array.isArray(q)) nome = q[0] || '';
  else if (typeof q === 'string') nome = q;
  if (!nome) {
    const m = /\/api\/crm\/([^/?#]+)/.exec(req.url || '');
    if (m) nome = m[1];
  }
  nome = String(nome).toLowerCase();

  const handler = Object.prototype.hasOwnProperty.call(rotas, nome) ? rotas[nome] : null;
  if (!handler) return res.status(404).json({ error: 'rota não encontrada' });

  try {
    return await handler(req, res);
  } catch (e) {
    console.error('rota ' + nome + ' falhou:', e && e.message);
    if (!res.headersSent) return res.status(500).json({ error: 'erro interno' });
  }
};
