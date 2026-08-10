// Notificações proativas do CRM Harpy — a plataforma passa a procurar o operador.
//
// Toda notificação é gravada no Vercel Blob em 'meta/notificacoes.json' (array, mais novas
// primeiro, no máximo 200). Essa gravação é a GARANTIA: é o que a aba de notificações do
// painel lê. O envio por WhatsApp é apenas um BÔNUS — a Meta só permite texto livre dentro
// da janela de 24h desde a última mensagem do destinatário, então a falha é ESPERADA e nunca
// pode derrubar nada. O resultado da tentativa fica registrado em `entregaWhatsapp`.
//
// Este arquivo fica FORA de api/ de propósito: qualquer .js dentro de api/ vira rota na
// Vercel, e este módulo não é um endpoint. Os endpoints o importam com
// require('../../lib/notificar') (de api/crm/) ou require('../lib/notificar') (de api/).
//
// NENHUMA função aqui lança: todas devolvem um valor seguro em caso de erro.
//
// Variáveis de ambiente: CRM_PREFIX, BLOB_READ_WRITE_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID

const GRAPH = 'https://graph.facebook.com/v21.0';
const REGISTRO = 'meta/notificacoes.json';
const LIMITE = 200;                       // quantas notificações ficam guardadas
const DESTINO = '5513992020409';          // número humano que recebe os avisos
const TIMEOUT_WHATSAPP = 8000;            // ms — envio é bônus, não pode travar o chamador

const TIPOS = ['lead', 'saude', 'resumo', 'campanha'];

// ---- helpers de storage (Vercel Blob via REST) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

// texto seguro e curto para caber tanto no painel quanto numa mensagem de WhatsApp
function texto(v, max) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\s+$/, '');
  if (!max || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function novoId() {
  return 'n' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

// aceita tanto o array cru quanto o formato {notificacoes:[...]} — tolerante a legado
function normalizar(bruto) {
  const arr = Array.isArray(bruto)
    ? bruto
    : (bruto && Array.isArray(bruto.notificacoes) ? bruto.notificacoes : []);
  return arr
    .filter(n => n && typeof n === 'object' && n.id)
    .map(n => ({
      id: String(n.id),
      tipo: TIPOS.indexOf(n.tipo) !== -1 ? n.tipo : 'campanha',
      titulo: texto(n.titulo, 200),
      detalhe: texto(n.detalhe, 4000),
      t: Number(n.t) > 0 ? Number(n.t) : 0,
      lida: n.lida === true,
      entregaWhatsapp: (n.entregaWhatsapp === 'ok' || n.entregaWhatsapp === 'falhou') ? n.entregaWhatsapp : null,
      erroWhatsapp: n.erroWhatsapp ? texto(n.erroWhatsapp, 300) : undefined
    }))
    .slice(0, LIMITE);
}

async function lerLista() {
  try {
    return normalizar(await blobGet(REGISTRO));
  } catch (e) {
    return [];
  }
}

// Envio pela Cloud API. Só funciona dentro da janela de 24h da Meta — a falha é esperada
// e vira apenas {ok:false, erro}. Nunca lança.
async function enviarWhatsapp(corpo) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneId || !token) return { ok: false, erro: 'WHATSAPP_TOKEN/WHATSAPP_PHONE_ID não configurados' };

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_WHATSAPP) : null;
  try {
    const opcoes = {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: DESTINO,
        type: 'text',
        text: { body: texto(corpo, 3500) }
      })
    };
    if (ctrl) opcoes.signal = ctrl.signal;
    const r = await fetch(GRAPH + '/' + phoneId + '/messages', opcoes);
    if (!r.ok) {
      let detalhe = 'erro HTTP ' + r.status;
      try {
        const d = await r.json();
        if (d && d.error && d.error.message) detalhe = d.error.message;
      } catch (e) { /* corpo ilegível: fica o status */ }
      return { ok: false, erro: detalhe };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: (e && e.message) || 'falha de rede' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Registra uma notificação. tipo: 'lead' | 'saude' | 'resumo' | 'campanha'.
// opcoes.whatsapp === false desliga o envio (usado pelos robôs, para o número humano não
// receber aviso do próprio fluxo de conversa em loop).
// Devolve a notificação gravada, ou null se nem isso foi possível. Nunca lança.
async function registrar(tipo, titulo, detalhe, opcoes) {
  try {
    const opts = opcoes || {};
    const notificacao = {
      id: novoId(),
      tipo: TIPOS.indexOf(tipo) !== -1 ? tipo : 'campanha',
      titulo: texto(titulo, 200) || 'Notificação',
      detalhe: texto(detalhe, 4000),
      t: Date.now(),
      lida: false,
      entregaWhatsapp: null
    };

    // o WhatsApp vem antes da gravação para o resultado já entrar no registro (uma escrita só)
    if (opts.whatsapp !== false) {
      const envio = await enviarWhatsapp(notificacao.titulo + '\n\n' + notificacao.detalhe);
      notificacao.entregaWhatsapp = envio.ok ? 'ok' : 'falhou';
      if (!envio.ok) {
        notificacao.erroWhatsapp = texto(envio.erro, 300);
        console.log('notificar: whatsapp nao entregue (esperado fora da janela de 24h):', envio.erro);
      }
    }

    const lista = await lerLista();
    lista.unshift(notificacao);
    await blobPut(REGISTRO, lista.slice(0, LIMITE));
    return notificacao;
  } catch (e) {
    console.error('notificar registrar falhou:', e && e.message);
    return null;
  }
}

// Todas as notificações, mais novas primeiro. Devolve [] em qualquer falha. Nunca lança.
async function listar() {
  const lista = await lerLista();
  return lista.sort((a, b) => (b.t || 0) - (a.t || 0));
}

// Marca as notificações informadas como lidas — ou TODAS quando ids não vier.
// Devolve {ok, marcadas, naoLidas}. Nunca lança.
async function marcarLidas(ids) {
  try {
    const lista = await lerLista();
    if (!lista.length) return { ok: true, marcadas: 0, naoLidas: 0 };

    const alvo = Array.isArray(ids) && ids.length
      ? ids.map(String)
      : null; // null = todas

    let marcadas = 0;
    for (const n of lista) {
      if (n.lida) continue;
      if (alvo === null || alvo.indexOf(n.id) !== -1) { n.lida = true; marcadas++; }
    }

    if (marcadas) await blobPut(REGISTRO, lista.slice(0, LIMITE));
    return { ok: true, marcadas, naoLidas: lista.filter(n => !n.lida).length };
  } catch (e) {
    console.error('notificar marcarLidas falhou:', e && e.message);
    return { ok: false, marcadas: 0, naoLidas: 0, erro: (e && e.message) || 'falha' };
  }
}

module.exports = { registrar, listar, marcarLidas };
