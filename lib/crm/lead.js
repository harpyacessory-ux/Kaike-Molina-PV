// Recebe os leads do formulário do site e grava no CRM.
//
// POST /api/crm/lead  (público — quem chama é o navegador do visitante)
//
// Por que existe: o formulário do site manda o visitante para o WhatsApp pessoal
// do Nicolas, que não é o número do robô. Sem este endpoint, o lead entra na
// planilha e no e-mail, mas nunca aparece no painel. Aqui ele é gravado no mesmo
// formato das conversas do robô (leads/<telefone>.json), então aparece na aba
// Leads e entra sozinho no funil pelo merge que /api/crm/store já faz.
//
// Sendo público, aceita só o essencial: origem conhecida, campos obrigatórios,
// tamanho limitado e o mesmo honeypot do formulário.

const ORIGENS = /^https:\/\/(www\.)?nicolastasso\.site$/;
const TAM_MAX = 8000;          // corpo inteiro; o formulário real manda ~1KB
const CAMPO_MAX = 500;

const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

function texto(v){
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, CAMPO_MAX);
}

// monta a "conversa" que aparece na aba Leads a partir do que a pessoa preencheu
function resumoDoFormulario(d){
  const linhas = [];
  if (d.negocio) linhas.push('Negócio: ' + d.negocio);
  if (d.canal) linhas.push('Onde vende: ' + d.canal);
  if (d.faturamento) linhas.push('Faturamento: ' + d.faturamento);
  if (d.mensagem) linhas.push('Desafio: ' + d.mensagem);
  if (d.origem) linhas.push('Origem: ' + d.origem);
  return 'Preencheu o formulário do site.' + (linhas.length ? '\n' + linhas.join('\n') : '');
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'método não permitido' });

  try {
    const origem = req.headers.origin || '';
    const referer = req.headers.referer || '';
    if (origem && !ORIGENS.test(origem)) return res.status(403).json({ error: 'origem não autorizada' });
    if (!origem && referer && !ORIGENS.test(referer.replace(/^(https:\/\/[^/]+).*$/, '$1'))) {
      return res.status(403).json({ error: 'origem não autorizada' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      if (body.length > TAM_MAX) return res.status(413).json({ error: 'corpo grande demais' });
      try { body = JSON.parse(body); } catch (e) { body = null; }
    }
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'dados inválidos' });
    if (body.botcheck) return res.status(200).json({ ok: true }); // honeypot: finge sucesso

    const nome = texto(body.nome);
    const whats = texto(body.whatsapp);
    const digitos = whats.replace(/\D/g, '');
    if (!nome || digitos.length < 10 || digitos.length > 13) {
      return res.status(400).json({ error: 'nome e whatsapp são obrigatórios' });
    }
    // normaliza para o mesmo formato usado pelo robô (DDI 55 + DDD + número)
    const id = digitos.length <= 11 ? '55' + digitos : digitos;

    const dados = {
      negocio: texto(body.negocio),
      canal: texto(body.canal),
      faturamento: texto(body.faturamento),
      mensagem: texto(body.mensagem),
      origem: texto(body.origem),
      utm_source: texto(body.utm_source),
      utm_campaign: texto(body.utm_campaign),
      utm_content: texto(body.utm_content)
    };

    const agora = Date.now();
    const anterior = await blobGet('leads/' + id + '.json').catch(() => null);
    const turns = (anterior && Array.isArray(anterior.turns)) ? anterior.turns.slice() : [];
    turns.push({ role: 'user', content: resumoDoFormulario(dados), t: agora });

    const lead = {
      id: id,
      nome: nome,
      turns: turns,
      criadoEm: (anterior && anterior.criadoEm) || agora,
      atualizadoEm: agora,
      // quem preenche nome, telefone e faturamento já é lead qualificado —
      // o merge do funil leva direto para a coluna "Qualificado"
      status: 'qualificado',
      canal: 'site',
      formulario: dados
    };

    await blobPut('leads/' + id + '.json', lead);
    try { await blobPut('meta/activity.json', { t: agora, ultimo: id }); } catch (e) { /* melhor-esforço */ }

    // avisa no painel (e tenta no WhatsApp) — nunca pode derrubar a resposta
    try {
      const { registrar } = require('../notificar');
      const detalhe = [
        'WhatsApp: ' + whats,
        dados.negocio ? 'Negócio: ' + dados.negocio : '',
        dados.faturamento ? 'Faturamento: ' + dados.faturamento : '',
        dados.origem ? 'Origem: ' + dados.origem : ''
      ].filter(Boolean).join('\n');
      await registrar('lead', 'Novo lead pelo site: ' + nome, detalhe, { whatsapp: true });
    } catch (e) { console.error('notificar falhou:', e && e.message); }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('lead erro:', e && e.message);
    // nunca devolve erro ao visitante: o site segue o fluxo dele normalmente
    return res.status(200).json({ ok: false });
  }
};

// CORS: o formulário roda em nicolastasso.site e chama esta API do navegador
function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ORIGENS.test(origin) || /^http:\/\/localhost:\d+$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}
