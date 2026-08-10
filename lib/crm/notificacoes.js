// CRM — central de notificações proativas do painel.
//
// GET  /api/crm/notificacoes            → { notificacoes, naoLidas }
// POST /api/crm/notificacoes  body {}   → marca TODAS como lidas
// POST /api/crm/notificacoes  {ids:[…]} → marca só as informadas
//
// Auth: header 'x-panel-key' === process.env.PANEL_KEY
// A escrita das notificações mora em lib/notificar.js (fora de api/ para não virar rota).

const { listar, marcarLidas } = require('../notificar');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (!req.headers['x-panel-key'] || req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const notificacoes = await listar();
      return res.status(200).json({
        notificacoes,
        naoLidas: notificacoes.filter(n => !n.lida).length
      });
    }

    if (req.method === 'POST') {
      // a Vercel entrega o JSON já parseado; se vier cru (string), parseamos aqui para não
      // marcar TODAS por engano quando o cliente pediu só algumas
      let body = req.body || {};
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      if (!body || typeof body !== 'object') body = {};
      // ids ausente / vazio = marcar todas
      const ids = Array.isArray(body.ids) ? body.ids.filter(x => x).map(String) : null;
      const r = await marcarLidas(ids);
      return res.status(200).json({ ok: true, marcadas: r.marcadas, naoLidas: r.naoLidas });
    }

    return res.status(405).json({ error: 'método não permitido' });
  } catch (e) {
    console.error('notificacoes erro:', e && e.message);
    return res.status(500).json({ error: 'erro ao consultar notificações' });
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
