/* =========================================================================
   CRM HARPY — SERVICE WORKER
   -------------------------------------------------------------------------
   O que ele faz (e, mais importante, o que ele NÃO faz):

   1) Guarda em cache apenas a "casca" do aplicativo — o HTML do painel, os
      scripts das abas, o manifesto e o ícone. Isso é o que faz o app abrir
      instantâneo e continuar abrindo mesmo com internet ruim.

   2) NUNCA guarda nada sob "/api/". Esses endereços devolvem dados privados
      (leads, telefones, conversas) e mutáveis (números da campanha). Eles
      passam direto para a rede, sem o service worker encostar. Se o celular
      estiver offline, a requisição falha — e o painel mostra o erro dele,
      que é o comportamento correto: melhor não mostrar número nenhum do que
      mostrar o número de ontem como se fosse o de hoje.

   3) Só intercepta GET do MESMO domínio. Requisições para o CDN do Instagram,
      para a Anthropic ou para qualquer outro domínio passam intocadas. O mesmo
      vale para qualquer requisição que carregue o cabeçalho Authorization
      (ou a chave do painel): conteúdo autenticado não entra em cache.

   4) Estratégia da casca: stale-while-revalidate. Responde na hora com a
      versão em cache (rápido) e, em segundo plano, busca a versão nova na
      rede e atualiza o cache. Na próxima abertura o usuário já vê o novo.
      Se não houver nada em cache, vai para a rede normalmente; se a rede
      falhar, o erro segue seu caminho (sem página falsa de "offline").

   Para forçar todo mundo a baixar uma casca nova, basta subir o número da
   versão em CACHE_NOME — o activate apaga os caches antigos da Harpy.
   ========================================================================= */

var CACHE_NOME = 'harpy-v2';
var PREFIXO_CACHE = 'harpy-';

/* casca do aplicativo — pré-carregada na instalação */
var CASCA = [
  '/painel',
  '/crm-ui/funil.js',
  '/crm-ui/contatos.js',
  '/crm-ui/tarefas.js',
  '/crm-ui/instagram.js',
  '/crm-ui/historico.js',
  '/crm-ui/atividade.js',
  '/crm-ui/assistente.js',
  '/crm-ui/instalar.js',
  '/manifest.webmanifest',
  '/icone-harpy.svg'
];

/* arquivos estáticos que também vale a pena servir do cache */
var ESTATICOS = /\.(?:js|css|svg|png|jpe?g|webp|ico|woff2?|webmanifest)$/i;

/* -------------------------------------------------------------------------
   Uma resposta só entra no cache se for "limpa": 200, do próprio domínio,
   sem redirecionamento (resposta redirecionada quebra navegação servida pelo
   service worker) e sem no-store.
   ------------------------------------------------------------------------- */
function podeGuardar(resposta) {
  if (!resposta || resposta.status !== 200) return false;
  if (resposta.type !== 'basic') return false;
  if (resposta.redirected) return false;
  var cc = resposta.headers.get('cache-control') || '';
  if (cc.toLowerCase().indexOf('no-store') !== -1) return false;
  return true;
}

/* Pré-carrega um item da casca sem derrubar a instalação inteira se ele
   ainda não existir no servidor (cada arquivo falha por conta própria). */
function precarregar(cache, caminho) {
  var req = new Request(caminho, { cache: 'reload', credentials: 'same-origin' });
  return fetch(req).then(function (resposta) {
    if (podeGuardar(resposta)) return cache.put(caminho, resposta);
  }).catch(function () { /* item indisponível: segue o baile */ });
}

/* =========================== INSTALAÇÃO ================================= */
self.addEventListener('install', function (evento) {
  evento.waitUntil(
    caches.open(CACHE_NOME).then(function (cache) {
      var tarefas = [];
      for (var i = 0; i < CASCA.length; i++) tarefas.push(precarregar(cache, CASCA[i]));
      return Promise.all(tarefas);
    }).then(function () {
      /* assume o controle já nesta versão, sem esperar as abas fecharem */
      return self.skipWaiting();
    })
  );
});

/* ============================ ATIVAÇÃO ================================== */
self.addEventListener('activate', function (evento) {
  evento.waitUntil(
    caches.keys().then(function (nomes) {
      var tarefas = [];
      for (var i = 0; i < nomes.length; i++) {
        /* apaga só os caches da Harpy de versões anteriores */
        if (nomes[i] !== CACHE_NOME && nomes[i].indexOf(PREFIXO_CACHE) === 0) {
          tarefas.push(caches.delete(nomes[i]));
        }
      }
      return Promise.all(tarefas);
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ============================== FETCH =================================== */

/* Decide se a requisição faz parte da casca (única coisa cacheável). */
function ehCasca(req, url) {
  if (req.mode === 'navigate') {
    /* só a navegação para o painel; qualquer outra página vai para a rede */
    return url.pathname === '/painel' || url.pathname === '/painel.html';
  }
  if (CASCA.indexOf(url.pathname) !== -1) return true;
  return ESTATICOS.test(url.pathname);
}

/* stale-while-revalidate: responde do cache e atualiza em segundo plano. */
function cascaComRevalidacao(evento, req) {
  return caches.open(CACHE_NOME).then(function (cache) {
    return cache.match(req, { ignoreSearch: req.mode === 'navigate' }).then(function (cacheado) {
      var daRede = fetch(req).then(function (resposta) {
        if (podeGuardar(resposta)) cache.put(req, resposta.clone());
        return resposta;
      }).catch(function (erro) {
        /* rede caiu: se havia cache, ele já foi devolvido lá embaixo;
           se não havia, o erro precisa subir para o navegador */
        if (cacheado) return cacheado;
        throw erro;
      });

      /* mantém o service worker vivo até a revalidação terminar */
      if (cacheado) evento.waitUntil(daRede);
      return cacheado || daRede;
    });
  });
}

self.addEventListener('fetch', function (evento) {
  var req = evento.request;

  /* 1) só GET — POST/PUT nunca são cacheados nem interceptados */
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  /* 2) só o mesmo domínio (fora: CDN do Instagram, Anthropic, etc.) */
  if (url.origin !== self.location.origin) return;

  /* 3) NUNCA a API: dados privados e mutáveis vão sempre à rede */
  if (url.pathname.indexOf('/api/') === 0) return;

  /* 4) nada autenticado e nada parcial (Range) entra em cache */
  if (req.headers.get('authorization')) return;
  if (req.headers.get('x-panel-key')) return;
  if (req.headers.get('range')) return;

  /* 5) fora da casca, deixa o navegador cuidar sozinho */
  if (!ehCasca(req, url)) return;

  evento.respondWith(cascaComRevalidacao(evento, req));
});
