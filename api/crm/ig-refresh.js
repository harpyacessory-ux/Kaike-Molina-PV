// CRM — renovação do token do Instagram sob demanda.
//
// GET|POST /api/crm/ig-refresh            → renova se o registro tiver mais de 7 dias
// GET|POST /api/crm/ig-refresh?forcar=1    → renova agora
//
// Auth (qualquer uma das duas):
//   header 'x-panel-key'   === process.env.PANEL_KEY      → chamada do painel
//   header 'authorization' === 'Bearer ' + CRON_SECRET    → agendamento diário da Vercel
//
// A Vercel envia o header Authorization automaticamente nos crons quando CRON_SECRET existe.
// Sem CRON_SECRET configurado, só a chave do painel autentica.
//
// Variáveis de ambiente: PANEL_KEY, CRON_SECRET (opcional), IG_TOKEN, CRM_PREFIX, BLOB_READ_WRITE_TOKEN

const { renovarSePreciso } = require('../../lib/ig-token');

function autorizado(req) {
  if (process.env.PANEL_KEY && req.headers['x-panel-key'] === process.env.PANEL_KEY) return true;
  if (process.env.CRON_SECRET && req.headers['authorization'] === 'Bearer ' + process.env.CRON_SECRET) return true;
  return false;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'método não permitido' });
  }
  if (!autorizado(req)) return res.status(401).json({ error: 'unauthorized' });

  const forcar = !!(req.query && String(req.query.forcar) === '1') || /[?&]forcar=1/.test(req.url || '');

  const r = await renovarSePreciso(forcar);

  const body = {
    ok: !r.erro,
    renovado: !!r.renovado,
    diasRestantes: r.diasRestantes !== undefined ? r.diasRestantes : null,
    expiraEm: r.expiraEm || null
  };
  if (r.motivo) body.motivo = r.motivo;
  if (r.erro) body.erro = r.erro;

  return res.status(200).json(body);
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
