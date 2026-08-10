// Token do Instagram que se renova sozinho — para nunca expirar.
//
// O token da conta @nicolastassooficial é do tipo "Instagram Login" (prefixo IGAA), fala com
// https://graph.instagram.com e vale ~60 dias. A Meta permite estender por mais 60 dias a
// qualquer momento, desde que o token ainda tenha pelo menos 24h de vida:
//
//   GET https://graph.instagram.com/refresh_access_token
//       ?grant_type=ig_refresh_token&access_token=<token_atual>
//   → { access_token, token_type, expires_in }   (expires_in em segundos)
//
// Como a env IG_TOKEN não pode ser reescrita em tempo de execução, o token vigente mora no
// Vercel Blob em 'meta/ig-token.json'. A env continua sendo a semente: enquanto não houver
// registro no blob, é ela que vale.
//
// Este arquivo fica FORA de api/ de propósito: qualquer .js dentro de api/ vira rota na
// Vercel, e este módulo não é um endpoint. Os endpoints o importam com
// require('../../lib/ig-token') a partir de api/crm/.
//
// Variáveis de ambiente: IG_TOKEN, CRM_PREFIX, BLOB_READ_WRITE_TOKEN

const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token';
const REGISTRO = 'meta/ig-token.json';
const RENOVAR_APOS_MS = 7 * 86400000;   // renova quando o registro guardado passa de 7 dias
const VALIDADE_PADRAO_MS = 60 * 86400000; // usado só se a Meta não devolver expires_in

// ---- helpers de storage (Vercel Blob via REST) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

// dias inteiros que faltam para o token expirar (null quando não sabemos)
function diasRestantes(expiraEm) {
  const n = Number(expiraEm);
  if (!isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.round((n - Date.now()) / 86400000));
}

// Registro guardado no blob: {token, atualizadoEm, expiraEm}. Nunca lança — devolve null.
async function lerRegistro() {
  try {
    const reg = await blobGet(REGISTRO);
    if (reg && typeof reg.token === 'string' && reg.token) return reg;
    return null;
  } catch (e) {
    return null;
  }
}

// Token vigente: o do blob quando existir, senão a semente da env. Nunca lança.
async function lerToken() {
  const reg = await lerRegistro();
  if (reg) return reg.token;
  return process.env.IG_TOKEN || '';
}

// Renova o token quando faz sentido. Nunca lança: em falha o token atual continua valendo
// e a próxima tentativa (painel ou cron diário) tenta de novo.
//   forcar === true  → renova agora, custe o que custar
//   sem registro     → o token veio da env e ainda não foi carimbado: renova para carimbar
//   registro velho   → mais de 7 dias desde atualizadoEm
async function renovarSePreciso(forcar) {
  const reg = await lerRegistro();
  const tokenAtual = (reg && reg.token) || process.env.IG_TOKEN || '';

  if (!tokenAtual) {
    return { renovado: false, expiraEm: null, diasRestantes: null, erro: 'IG_TOKEN não configurado' };
  }

  const atualizadoEm = reg && Number(reg.atualizadoEm) > 0 ? Number(reg.atualizadoEm) : null;
  const idadeMs = atualizadoEm ? Date.now() - atualizadoEm : null;
  const precisa = forcar === true || !reg || idadeMs === null || idadeMs > RENOVAR_APOS_MS;

  if (!precisa) {
    return {
      renovado: false,
      expiraEm: reg.expiraEm || null,
      diasRestantes: diasRestantes(reg.expiraEm),
      motivo: 'token renovado há menos de 7 dias'
    };
  }

  // A Meta recusa a renovação de token com menos de 24h de vida — nesse caso o erro dela
  // vem no corpo e é devolvido aqui como {renovado:false, erro}, sem derrubar quem chamou.
  let novo = null, expiraMs = 0;
  try {
    const r = await fetch(REFRESH_URL + '?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(tokenAtual));
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error || !d.access_token) {
      const msg = (d && d.error && d.error.message) || ('erro HTTP ' + r.status);
      return { renovado: false, expiraEm: (reg && reg.expiraEm) || null, diasRestantes: diasRestantes(reg && reg.expiraEm), erro: msg };
    }
    novo = d.access_token;
    expiraMs = Number(d.expires_in) > 0 ? Number(d.expires_in) * 1000 : VALIDADE_PADRAO_MS;
  } catch (e) {
    return { renovado: false, expiraEm: (reg && reg.expiraEm) || null, diasRestantes: diasRestantes(reg && reg.expiraEm), erro: e.message };
  }

  const agora = Date.now();
  const expiraEm = agora + expiraMs;
  try {
    await blobPut(REGISTRO, { token: novo, atualizadoEm: agora, expiraEm });
  } catch (e) {
    // token novo obtido mas não guardado: o antigo segue válido, tentamos de novo depois
    return { renovado: false, expiraEm: (reg && reg.expiraEm) || null, diasRestantes: diasRestantes(reg && reg.expiraEm), erro: 'falha ao gravar o token: ' + e.message };
  }

  return { renovado: true, expiraEm, diasRestantes: diasRestantes(expiraEm) };
}

module.exports = { lerToken, renovarSePreciso, lerRegistro, diasRestantes };
