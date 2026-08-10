// Motor de análise do painel CRM — coleta métricas da Meta Marketing API,
// calcula KPIs contra o baseline pré-consolidação e gera recomendações.
//
// PRINCÍPIO: a matemática é feita aqui, em JavaScript, de forma determinística.
// A IA (Claude) entra SOMENTE para redigir título e motivo de achados que o
// código já qualificou. A IA nunca decide se algo é significativo, nunca
// inventa achados e nunca compara anúncios que não passaram no teste de volume.
// Se nenhum achado se qualifica, a lista de recomendações vem VAZIA — e isso é
// o comportamento correto: é melhor não dizer nada do que analisar ruído.
//
// GET /api/crm/insights  (header obrigatório: x-panel-key)
//
// Variáveis de ambiente: ADS_TOKEN, ANTHROPIC_API_KEY, PANEL_KEY, CRM_PREFIX, BLOB_READ_WRITE_TOKEN

const GRAPH = 'https://graph.facebook.com/v21.0';
const ACCOUNT = 'act_1952702155392886';
const ADSET_CONSOLIDADO = '52713910773930';
const MODEL = 'claude-haiku-4-5';
const INICIO_CONSOLIDACAO = '2026-08-09';

// baseline fixo — período pré-consolidação (04 a 08/08/2026)
const BASELINE = { gasto: 99.53, cpm: 90, cpl: 24.88, leads: 4, ctr: 4.45 };

// ---------------------------------------------------------------------------
// LIMIARES — cada um com a origem documentada. Nenhum número mágico solto.
// ---------------------------------------------------------------------------

// Meta exige ~50 eventos otimizados em 7 dias para um conjunto sair da fase de
// aprendizado. Abaixo disso a entrega fica instável e o CPM alto — é a regra
// oficial da plataforma para OFFSITE_CONVERSIONS.
const CONVERSOES_SEMANA_APRENDIZADO = 50;
const DIAS_JANELA_APRENDIZADO = 7;

// Para comparar duas coisas entre si (dois anúncios, dois períodos) é preciso um
// mínimo de ~15 conversões por lado; abaixo disso a diferença observada cabe
// dentro do intervalo de confiança e não é sinal, é ruído.
const CONVERSOES_MIN_LEITURA = 15;

// Volume mínimo por anúncio para que o CTR dele signifique alguma coisa.
// 1000 impressões / 100 cliques é o piso usual de leitura: com 25 impressões e
// 1 clique, o "CTR de 4%" tem margem de erro maior que o próprio número.
const IMPRESSOES_MIN_ANUNCIO = 1000;
const CLIQUES_MIN_ANUNCIO = 100;

// Com o CPL histórico (~R$25) e um CTR de ~4%, 50 cliques sem nenhum lead já é
// mais do que o esperado por acaso — a partir daí vale suspeitar de pixel /
// formulário / rastreio. Abaixo de 50 cliques, zero lead é estatisticamente
// normal e NÃO é sinal de problema.
const CLIQUES_SEM_LEAD_SUSPEITO = 50;

// Desvio de ritmo: só é achado quando a entrega está bem abaixo (<60% do
// planejado) ou bem acima (>150%). Entre 0,6x e 1,5x é oscilação normal de leilão.
const DESVIO_RITMO_BAIXO = 0.6;
const DESVIO_RITMO_ALTO = 1.5;

// Anúncio "sem entrega": o leilão praticamente o ignorou. Menos de 30 impressões
// enquanto um irmão do mesmo conjunto passou de 150 é fato de ENTREGA
// (distribuição), não de desempenho — por isso não exige volume estatístico.
const IMPRESSOES_SEM_ENTREGA = 30;
const IMPRESSOES_ENTREGA_NORMAL = 150;

// Teto já validado em apply.js para ajuste de orçamento (R$ 600,00).
const ORCAMENTO_MAX_CENTAVOS = 60000;

// Campos do conjunto na Graph API (o mínimo é o fallback do que o painel já consumia)
const CAMPOS_CONJUNTO_MINIMO = 'name,status,effective_status,lifetime_budget,daily_budget';
const CAMPOS_CONJUNTO = CAMPOS_CONJUNTO_MINIMO +
  ',budget_remaining,start_time,end_time,optimization_goal,adset_schedule,pacing_type';

// ---- helpers de storage (Vercel Blob via REST) ----
const PFX = 'crm-' + process.env.CRM_PREFIX;
async function blobPut(path, obj){ const r = await fetch('https://blob.vercel-storage.com/' + PFX + '/' + path, {method:'PUT', headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7','content-type':'application/json','x-add-random-suffix':'0'}, body: JSON.stringify(obj)}); if(!r.ok) throw new Error('blob put '+r.status); return r.json(); }
async function blobList(prefix){ const r = await fetch('https://blob.vercel-storage.com/?prefix=' + encodeURIComponent(PFX + '/' + prefix) + '&limit=1000', {headers:{'Authorization':'Bearer '+process.env.BLOB_READ_WRITE_TOKEN,'x-api-version':'7'}}); if(!r.ok) throw new Error('blob list '+r.status); const d = await r.json(); return d.blobs || []; }
async function blobGet(path){ const bs = await blobList(path); if(!bs.length) return null; try{ const r = await fetch(bs[0].url + '?t=' + Date.now(), {cache:'no-store'}); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }

// ---- helper da Graph API ----
async function graphGet(pathAndQuery) {
  const r = await fetch(GRAPH + pathAndQuery, {
    headers: { 'Authorization': 'Bearer ' + process.env.ADS_TOKEN }
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) {
    const msg = (d && d.error && d.error.message) || ('graph http ' + r.status);
    throw new Error(msg);
  }
  return d;
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function arred(n, casas) { const f = Math.pow(10, casas == null ? 2 : casas); return Math.round(n * f) / f; }
function brl(n) { return 'R$ ' + (Math.round(n * 100) / 100).toFixed(2).replace('.', ','); }

// slug estável a partir de um texto (para ids de recomendação que persistem)
function slug(txt) {
  return String(txt || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';
}

// diferença em dias entre duas datas ISO (mínimo 1, null se inválido)
function diasEntre(inicio, fim) {
  const a = Date.parse(inicio), b = Date.parse(fim);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.max(1, Math.round((b - a) / 86400000));
}

function extrairLeads(actions) {
  if (!Array.isArray(actions)) return 0;
  const a = actions.find(x => x.action_type === 'lead');
  return a ? num(a.value) : 0;
}

// day-parting: o conjunto tem veiculação restrita a determinadas faixas de horário
function temDayParting(conjunto) {
  if (!conjunto) return false;
  if (Array.isArray(conjunto.adset_schedule) && conjunto.adset_schedule.length > 0) return true;
  const pacing = conjunto.pacing_type;
  return Array.isArray(pacing) && pacing.some(p => String(p).indexOf('day_parting') > -1);
}

// aplica o estado salvo (pendente | ignorada | aplicada) sobre as recomendações
function mesclarEstado(recomendacoes, recs) {
  const estados = recs || {};
  return (recomendacoes || []).map(r => Object.assign({}, r, { estado: estados[r.id] || 'pendente' }));
}

// ===========================================================================
// 1) DIAGNÓSTICO — os FATOS, calculados em JavaScript. Sem IA, sem opinião.
// ===========================================================================
function diagnosticar(kpis, porAnuncio, conjuntos, porDia, baseline) {
  const conjunto = (conjuntos || []).find(c => String(c.id) === ADSET_CONSOLIDADO) || null;

  // --- tempo e ritmo ---
  const agora = new Date().toISOString();
  const hoje = agora.slice(0, 10);

  const gasto = num(kpis.gasto);
  const leads = num(kpis.leads);

  // diasCorridos: só contam dias em que houve gasto (dia sem veiculação não é
  // amostra; incluí-lo diluiria a média e faria o motor subestimar o ritmo).
  const diasComGasto = (porDia || []).filter(d => num(d.gasto) > 0);
  // Se a série diária não vier (a chamada por dia tem try/catch próprio e pode
  // falhar sozinha), ainda existe gasto a analisar: cai para os dias decorridos
  // desde o início do conjunto. Sem esse fallback, a falha de UMA chamada zerava
  // a amostra, calava todos os achados e ainda fazia o painel afirmar que não
  // houve gasto no período — o que é falso.
  const diasCorridos = diasComGasto.length ||
    (gasto > 0 ? ((conjunto && diasEntre(conjunto.start_time, agora)) || 1) : 0);

  const gastoMedioDia = diasCorridos > 0 ? gasto / diasCorridos : null;

  // Ritmo de entrega: o dia CORRENTE está incompleto — e este conjunto ainda
  // veicula só em parte do dia — então incluí-lo na média puxa o ritmo para
  // baixo e fabrica "entrega abaixo do planejado" só por consultar de manhã.
  // O desvio de ritmo usa exclusivamente dias JÁ FECHADOS; sem nenhum dia
  // fechado não existe leitura de ritmo e o achado não é emitido.
  const diasFechados = diasComGasto.filter(d => String(d.data) !== hoje);
  const gastoMedioDiaFechado = diasFechados.length > 0
    ? diasFechados.reduce((s, d) => s + num(d.gasto), 0) / diasFechados.length
    : null;

  // ritmoPlanejado = lifetime_budget do conjunto ÷ dias entre start_time e end_time
  const orcamentoTotalCentavos = conjunto ? parseInt(conjunto.lifetime_budget, 10) : NaN;
  const orcamentoTotal = Number.isFinite(orcamentoTotalCentavos) ? orcamentoTotalCentavos / 100 : null;
  const diasPlanejados = conjunto ? diasEntre(conjunto.start_time, conjunto.end_time) : null;
  const ritmoPlanejado = (orcamentoTotal != null && diasPlanejados) ? orcamentoTotal / diasPlanejados : null;
  const desvioDeRitmo = (ritmoPlanejado && gastoMedioDiaFechado != null)
    ? gastoMedioDiaFechado / ritmoPlanejado
    : null;

  // dias que ainda restam de veiculação (a partir de agora até o end_time)
  const diasRestantes = conjunto ? diasEntre(agora, conjunto.end_time) : null;

  // --- custo por lead ---
  const cplEfetivo = leads > 0 ? gasto / leads : null;                    // só existe com lead real
  const cplReferencia = cplEfetivo != null
    ? cplEfetivo
    : (baseline && baseline.cpl > 0 ? baseline.cpl : null);              // senão, o histórico

  // --- fase de aprendizado (a matemática que o motor antigo ignorava) ---
  // Projeta o ritmo de conversões para uma semana e compara com a regra da Meta.
  const conversoesPorSemanaProjetadas = (leads > 0 && diasCorridos > 0)
    ? (leads / diasCorridos) * DIAS_JANELA_APRENDIZADO
    : 0;
  const saiDoAprendizado = conversoesPorSemanaProjetadas >= CONVERSOES_SEMANA_APRENDIZADO;
  // quanto seria preciso gastar POR DIA para produzir 50 conversões em 7 dias
  const orcamentoDiarioNecessario = cplReferencia != null
    ? (CONVERSOES_SEMANA_APRENDIZADO / DIAS_JANELA_APRENDIZADO) * cplReferencia
    : null;

  // --- a partir de quando os dados começam a ser legíveis ---
  const gastoAteLeituraConfiavel = cplReferencia != null ? cplReferencia * CONVERSOES_MIN_LEITURA : null;
  const diasAteLeitura = (gastoAteLeituraConfiavel != null && gastoMedioDia > 0)
    ? Math.max(0, (gastoAteLeituraConfiavel - gasto) / gastoMedioDia)
    : null;

  // --- volume por anúncio (marca o campo temVolume em cada anúncio) ---
  (porAnuncio || []).forEach(a => {
    a.temVolume = num(a.impressoes) >= IMPRESSOES_MIN_ANUNCIO && num(a.cliques) >= CLIQUES_MIN_ANUNCIO;
  });
  const anunciosComVolume = (porAnuncio || []).filter(a => a.temVolume).length;
  // Regra dura: com menos de 2 anúncios com volume, é PROIBIDO comparar anúncios.
  const podeCompararAnuncios = anunciosComVolume >= 2;

  // --- possível falha de medição ---
  const possivelFalhaDeMedicao = num(kpis.cliques) >= CLIQUES_SEM_LEAD_SUSPEITO && leads === 0;

  // --- há amostra suficiente para diagnosticar qualquer coisa? ---
  // Basta existir gasto: diasCorridos já tem fallback próprio, então uma falha
  // na série diária não pode mais apagar o diagnóstico inteiro.
  const temAmostra = gasto > 0;

  return {
    temAmostra,
    diasCorridos,
    gasto: arred(gasto),
    leads,
    cliques: num(kpis.cliques),
    impressoes: num(kpis.impressoes),
    gastoMedioDia: gastoMedioDia != null ? arred(gastoMedioDia) : null,
    diasFechados: diasFechados.length,
    gastoMedioDiaFechado: gastoMedioDiaFechado != null ? arred(gastoMedioDiaFechado) : null,
    orcamentoTotal,
    diasPlanejados,
    diasRestantes,
    ritmoPlanejado: ritmoPlanejado != null ? arred(ritmoPlanejado) : null,
    desvioDeRitmo: desvioDeRitmo != null ? arred(desvioDeRitmo, 3) : null,
    cplEfetivo: cplEfetivo != null ? arred(cplEfetivo) : null,
    cplReferencia: cplReferencia != null ? arred(cplReferencia) : null,
    conversoesPorSemanaProjetadas: arred(conversoesPorSemanaProjetadas, 1),
    saiDoAprendizado,
    conversoesNecessariasPorSemana: CONVERSOES_SEMANA_APRENDIZADO,
    orcamentoDiarioNecessario: orcamentoDiarioNecessario != null ? arred(orcamentoDiarioNecessario) : null,
    gastoAteLeituraConfiavel: gastoAteLeituraConfiavel != null ? arred(gastoAteLeituraConfiavel) : null,
    diasAteLeitura: diasAteLeitura != null ? arred(diasAteLeitura, 1) : null,
    anunciosComVolume,
    podeCompararAnuncios,
    possivelFalhaDeMedicao,
    conjunto: conjunto ? {
      id: String(conjunto.id),
      nome: conjunto.name || null,
      optimization_goal: conjunto.optimization_goal || null,
      lifetime_budget_centavos: Number.isFinite(orcamentoTotalCentavos) ? orcamentoTotalCentavos : null,
      budget_remaining_centavos: conjunto.budget_remaining != null ? parseInt(conjunto.budget_remaining, 10) : null,
      start_time: conjunto.start_time || null,
      end_time: conjunto.end_time || null,
      dayParting: temDayParting(conjunto)
    } : null
  };
}

// ===========================================================================
// 2) ACHADOS QUALIFICADOS — só entra o que os fatos sustentam.
//    Cada achado carrega id estável, prioridade, ação e texto padrão.
// ===========================================================================

// monta uma ação de ajuste de orçamento se o valor sugerido couber no teto do apply.js
function acaoOrcamento(fatos, novoTotalReais) {
  if (!fatos.conjunto || !Number.isFinite(novoTotalReais)) return null;
  const centavos = Math.round(novoTotalReais * 100);
  const atual = fatos.conjunto.lifetime_budget_centavos;
  if (centavos <= 0 || centavos > ORCAMENTO_MAX_CENTAVOS) return null;      // não cabe no teto validado
  if (atual != null && Math.abs(centavos - atual) < Math.max(500, atual * 0.05)) return null; // diferença irrelevante
  return { tipo: 'ajustar_orcamento', params: { id: fatos.conjunto.id, lifetime_budget: centavos } };
}

function montarAchados(fatos, porAnuncio) {
  const achados = [];
  if (!fatos.temAmostra) return achados;   // sem gasto/dia nenhum: nada a dizer

  // --- aprendizado inviável (maior prioridade quando presente) ---
  if (!fatos.saiDoAprendizado) {
    const necessarioDia = fatos.orcamentoDiarioNecessario;
    // orçamento total que sustentaria 50 conversões/semana pelo tempo restante
    const totalNecessario = (necessarioDia != null && fatos.diasRestantes)
      ? fatos.gasto + necessarioDia * fatos.diasRestantes
      : null;
    const acao = totalNecessario != null ? acaoOrcamento(fatos, totalNecessario) : null;

    achados.push({
      chave: 'aprendizado-inviavel',
      id: 'aprendizado-inviavel',
      prioridade: 'alta',
      acao: acao || { tipo: 'nenhuma', params: {} },
      dados: {
        conversoesPorSemanaProjetadas: fatos.conversoesPorSemanaProjetadas,
        necessarioPorSemana: CONVERSOES_SEMANA_APRENDIZADO,
        cplReferencia: fatos.cplReferencia,
        gastoMedioDia: fatos.gastoMedioDia,
        orcamentoDiarioNecessario: necessarioDia,
        orcamentoTotalNecessario: totalNecessario != null ? arred(totalNecessario) : null,
        cabeNoTeto: !!acao,
        evento: (fatos.conjunto && fatos.conjunto.optimization_goal) || null
      },
      tituloPadrao: 'Campanha não sai da fase de aprendizado',
      motivoPadrao: 'Com ' + brl(fatos.gastoMedioDia || 0) + '/dia e CPL de referência de ' +
        brl(fatos.cplReferencia || 0) + ', a projeção é de ' + fatos.conversoesPorSemanaProjetadas +
        ' conversões por semana — a Meta precisa de ' + CONVERSOES_SEMANA_APRENDIZADO +
        ' em 7 dias para estabilizar a entrega, o que explica o CPM alto. Seriam necessários ~' +
        brl(necessarioDia || 0) + '/dia para atingir esse volume' +
        (acao ? '.' : '; como isso não cabe no orçamento, a alternativa é otimizar por um evento mais frequente (ex.: visualização de página) até haver volume.')
    });
  }

  // --- ritmo de entrega fora do planejado ---
  if (fatos.desvioDeRitmo != null &&
      (fatos.desvioDeRitmo < DESVIO_RITMO_BAIXO || fatos.desvioDeRitmo > DESVIO_RITMO_ALTO)) {
    const abaixo = fatos.desvioDeRitmo < DESVIO_RITMO_BAIXO;
    // realinhar o orçamento total ao ritmo que a conta realmente entrega.
    // Só sugerimos esse ajuste quando ele NÃO contradiz o achado de aprendizado:
    // reduzir orçamento de um conjunto que já não sai do aprendizado só pioraria
    // a falta de sinal, então nesse caso a recomendação fica apenas informativa.
    const podeRealinhar = !abaixo || fatos.saiDoAprendizado;
    // usa o ritmo medido em dias FECHADOS — o mesmo número que qualificou o achado
    const ritmoReal = fatos.gastoMedioDiaFechado;
    const totalRealinhado = (podeRealinhar && ritmoReal != null && fatos.diasPlanejados)
      ? ritmoReal * fatos.diasPlanejados
      : null;
    const acao = totalRealinhado != null ? acaoOrcamento(fatos, totalRealinhado) : null;

    achados.push({
      chave: 'ritmo-de-entrega',
      id: 'ritmo-de-entrega',
      prioridade: 'media',
      acao: acao || { tipo: 'nenhuma', params: {} },
      dados: {
        gastoMedioDiaFechado: ritmoReal,
        diasFechados: fatos.diasFechados,
        ritmoPlanejado: fatos.ritmoPlanejado,
        desvioDeRitmo: fatos.desvioDeRitmo,
        direcao: abaixo ? 'abaixo' : 'acima',
        diasRestantes: fatos.diasRestantes
      },
      tituloPadrao: abaixo ? 'Entrega abaixo do ritmo planejado' : 'Entrega acima do ritmo planejado',
      motivoPadrao: 'O conjunto está gastando ' + brl(ritmoReal || 0) + '/dia contra ' +
        brl(fatos.ritmoPlanejado || 0) + '/dia previstos pelo orçamento total (' +
        Math.round(fatos.desvioDeRitmo * 100) + '% do planejado). No ritmo atual o orçamento não fecha como programado.'
    });
  }

  // --- janela de veiculação restrita agravando a falta de sinal ---
  if (fatos.conjunto && fatos.conjunto.dayParting && !fatos.saiDoAprendizado) {
    achados.push({
      chave: 'janela-de-veiculacao',
      id: 'janela-de-veiculacao',
      prioridade: 'media',
      acao: { tipo: 'nenhuma', params: {} },
      dados: {
        gastoMedioDia: fatos.gastoMedioDia,
        conversoesPorSemanaProjetadas: fatos.conversoesPorSemanaProjetadas
      },
      tituloPadrao: 'Horário restrito com orçamento pequeno',
      motivoPadrao: 'O conjunto tem veiculação limitada a faixas de horário e ainda está fora da fase de aprendizado. ' +
        'Restringir horário com ' + brl(fatos.gastoMedioDia || 0) + '/dia reduz ainda mais o volume de eventos ' +
        'e atrasa a estabilização da entrega.'
    });
  }

  // --- possível falha de medição ---
  if (fatos.possivelFalhaDeMedicao) {
    achados.push({
      chave: 'possivel-falha-medicao',
      id: 'possivel-falha-medicao',
      prioridade: 'alta',
      acao: { tipo: 'nenhuma', params: {} },
      dados: { cliques: fatos.cliques, leads: fatos.leads, cplReferencia: fatos.cplReferencia },
      tituloPadrao: 'Cliques sem nenhum lead registrado',
      motivoPadrao: 'São ' + fatos.cliques + ' cliques e nenhum lead registrado. Com o CPL de referência de ' +
        brl(fatos.cplReferencia || 0) + ', a essa altura já era esperado ao menos 1 lead — vale conferir pixel, ' +
        'evento de conversão e formulário antes de mexer em orçamento ou criativo.'
    });
  }

  // --- anúncio ativo que o leilão está ignorando (fato de entrega, não de desempenho) ---
  const maiorImpressoes = (porAnuncio || []).reduce((m, a) => Math.max(m, num(a.impressoes)), 0);
  if (maiorImpressoes > IMPRESSOES_ENTREGA_NORMAL) {
    (porAnuncio || []).forEach(a => {
      const ativo = String(a.effective_status || '').toUpperCase() === 'ACTIVE';
      if (!ativo || num(a.impressoes) >= IMPRESSOES_SEM_ENTREGA) return;
      // Pausar um anúncio edita o conjunto e reinicia a fase de aprendizado da Meta.
      // Oferecer esse botão num conjunto que JÁ não consegue sair do aprendizado
      // contradiz o achado de maior prioridade e só pioraria a falta de sinal —
      // é a mesma regra já aplicada ao ajuste de orçamento em 'ritmo-de-entrega'.
      // Enquanto o aprendizado não fechar, o achado é informativo.
      const idAceitoPeloApply = a.id && /^527[0-9]{10,}$/.test(String(a.id));  // mesmo formato aceito por apply.js
      const podePausar = idAceitoPeloApply && fatos.saiDoAprendizado;
      achados.push({
        chave: 'anuncio-sem-entrega',
        // id do anúncio é o identificador mais estável; o slug do nome é só fallback
        id: 'anuncio-sem-entrega-' + (a.id ? String(a.id) : slug(a.nome)),
        prioridade: 'media',
        acao: podePausar ? { tipo: 'pausar_anuncio', params: { id: String(a.id) } } : { tipo: 'nenhuma', params: {} },
        dados: {
          anuncio: a.nome,
          impressoes: num(a.impressoes),
          maiorImpressoesDoConjunto: maiorImpressoes,
          pausarAdiado: !!(idAceitoPeloApply && !fatos.saiDoAprendizado)
        },
        tituloPadrao: 'Anúncio sem entrega: ' + (a.nome || 'sem nome'),
        motivoPadrao: 'O anúncio está ativo mas recebeu apenas ' + num(a.impressoes) +
          ' impressões, enquanto outro do mesmo conjunto passou de ' + maiorImpressoes +
          '. É um fato de entrega — o leilão praticamente não o está distribuindo — e não uma leitura de desempenho.' +
          (podePausar ? '' : ' Não há botão para pausá-lo agora: qualquer edição no conjunto reinicia a fase de aprendizado, ' +
            'que ainda não fechou — mexer nos criativos antes disso só atrasaria mais a estabilização da entrega.')
      });
    });
  }

  // --- comparação entre anúncios: SOMENTE com 2+ anúncios com volume ---
  if (fatos.podeCompararAnuncios) {
    const comVolume = (porAnuncio || []).filter(a => a.temVolume)
      .sort((x, y) => num(y.ctr) - num(x.ctr));
    const melhor = comVolume[0], pior = comVolume[comVolume.length - 1];
    achados.push({
      chave: 'comparacao-de-anuncios',
      id: 'comparacao-de-anuncios',
      prioridade: 'baixa',
      acao: { tipo: 'nenhuma', params: {} },
      dados: {
        melhor: { nome: melhor.nome, ctr: num(melhor.ctr), impressoes: num(melhor.impressoes), cliques: num(melhor.cliques) },
        pior: { nome: pior.nome, ctr: num(pior.ctr), impressoes: num(pior.impressoes), cliques: num(pior.cliques) },
        anunciosComVolume: fatos.anunciosComVolume
      },
      tituloPadrao: 'Diferença de CTR entre anúncios com volume',
      motivoPadrao: '"' + melhor.nome + '" está com CTR de ' + arred(num(melhor.ctr)) + '% (' +
        num(melhor.cliques) + ' cliques em ' + num(melhor.impressoes) + ' impressões) contra ' +
        arred(num(pior.ctr)) + '% de "' + pior.nome + '". Ambos já têm volume suficiente para a comparação ser confiável.'
    });
  }

  // ordena por prioridade (alta → média → baixa), preservando a ordem interna
  const peso = { alta: 0, media: 1, baixa: 2 };
  return achados.sort((a, b) => peso[a.prioridade] - peso[b.prioridade]);
}

// ===========================================================================
// 3) REDAÇÃO PELA IA — a IA só escreve titulo/motivo dos achados recebidos.
// ===========================================================================

// parse defensivo: devolve um mapa { id: {titulo, motivo} } só com ids conhecidos
function parseRedacao(texto, idsValidos) {
  const mapa = {};
  if (!texto) return mapa;
  let t = String(texto).replace(/```(?:json)?/gi, '').trim();
  const ini = t.indexOf('['), fim = t.lastIndexOf(']');
  if (ini === -1 || fim === -1 || fim <= ini) return mapa;
  try {
    const arr = JSON.parse(t.slice(ini, fim + 1));
    if (!Array.isArray(arr)) return mapa;
    arr.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const id = String(item.id || '');
      if (!idsValidos.has(id)) return;                 // ignora qualquer id que a IA tenha inventado
      const titulo = String(item.titulo || '').trim();
      const motivo = String(item.motivo || '').trim();
      if (!titulo && !motivo) return;
      mapa[id] = {
        titulo: titulo ? titulo.slice(0, 120) : null,
        motivo: motivo ? motivo.slice(0, 600) : null
      };
    });
  } catch (e) { /* redação falhou: os textos padrão assumem */ }
  return mapa;
}

async function redigirAchados(fatos, achados) {
  const system = 'Você é redator técnico de tráfego pago. Sua ÚNICA função é redigir, em português do Brasil, ' +
    'o título e o motivo de achados que já foram calculados e validados por código. ' +
    'Responda SOMENTE com um array JSON válido, sem texto antes ou depois e sem cercas de markdown.';

  const user = `Abaixo estão FATOS calculados deterministicamente sobre uma campanha da Meta Ads e a lista de ACHADOS já qualificados por código.

REGRAS OBRIGATÓRIAS:
- Escreva titulo e motivo para CADA achado da lista, usando o campo "id" recebido, sem alterá-lo.
- O motivo deve ter de 1 a 3 frases, citar os números concretos dos fatos e ser claro para um cliente leigo. Sem jargão inútil.
- NÃO invente achados novos. NÃO comente nada que esteja fora da lista de achados.
- NÃO chame de tendência, de melhor ou de pior desempenho nada que os fatos não tenham marcado como tendo volume ("temVolume"/"podeCompararAnuncios").
- NÃO sugira ações além das que já vêm no campo "acao" de cada achado.
- Se um número não estiver nos fatos, não o cite.

FORMATO DA RESPOSTA — SOMENTE um array JSON:
[{"id": "<id recebido, inalterado>", "titulo": "...", "motivo": "..."}]

FATOS:
${JSON.stringify(fatos)}

ACHADOS QUALIFICADOS:
${JSON.stringify(achados.map(a => ({ id: a.id, tipo: a.chave, prioridade: a.prioridade, acao: a.acao, dados: a.dados })))}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !Array.isArray(d.content)) {
    const msg = (d && d.error && d.error.message) || ('anthropic http ' + r.status);
    throw new Error(msg);
  }
  const bloco = d.content.find(b => b.type === 'text');
  return parseRedacao(bloco && bloco.text, new Set(achados.map(a => a.id)));
}

// converte achados (+ redação opcional) no formato que o painel e o /apply consomem
function montarRecomendacoes(achados, redacao) {
  const textos = redacao || {};
  return achados.map(a => {
    const t = textos[a.id] || {};
    return {
      id: a.id,
      titulo: t.titulo || a.tituloPadrao,
      motivo: t.motivo || a.motivoPadrao,
      prioridade: a.prioridade,
      acao: a.acao
    };
  });
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.headers['x-panel-key'] !== process.env.PANEL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'metodo nao permitido' });

  try {
    // ---- cache (10 minutos) — sempre re-mescla o estado das recomendações ----
    const cache = await blobGet('meta/insights-cache.json').catch(() => null);
    if (cache && cache.t > Date.now() - 600000 && cache.body) {
      const recs = await blobGet('meta/recs.json').catch(() => null);
      const body = Object.assign({}, cache.body, {
        recomendacoes: mesclarEstado(cache.body.recomendacoes, recs),
        cacheado: true
      });
      return res.status(200).json(body);
    }

    // ---- coleta da Graph API (cada bloco com try/catch próprio) ----
    const hoje = new Date().toISOString().slice(0, 10);
    const timeRange = encodeURIComponent(JSON.stringify({ since: INICIO_CONSOLIDACAO, until: hoje }));

    let totais = null, totaisErro = null;
    let porDia = [], porDiaErro = null;
    let porAnuncio = [], porAnuncioErro = null;
    let conjuntos = [], conjuntosErro = null;
    let anunciosConsolidado = [], anunciosErro = null;

    await Promise.all([
      graphGet('/' + ACCOUNT + '/insights?level=campaign&fields=spend,impressions,clicks,ctr,cpm,actions&time_range=' + timeRange)
        .then(d => { totais = (d.data && d.data[0]) || null; })
        .catch(e => { totaisErro = e.message; }),
      graphGet('/' + ACCOUNT + '/insights?level=campaign&fields=spend,impressions,clicks,ctr,cpm,actions&time_increment=1&time_range=' + timeRange)
        .then(d => { porDia = d.data || []; })
        .catch(e => { porDiaErro = e.message; }),
      graphGet('/' + ADSET_CONSOLIDADO + '/insights?level=ad&fields=ad_name,spend,impressions,clicks,ctr,actions&date_preset=maximum')
        .then(d => { porAnuncio = d.data || []; })
        .catch(e => { porAnuncioErro = e.message; }),
      // campos extras do conjunto: necessários para ritmo planejado, evento otimizado e day-parting.
      // Se a Graph recusar algum campo, cai para o conjunto mínimo para não perder a lista do painel.
      graphGet('/' + ACCOUNT + '/adsets?fields=' + CAMPOS_CONJUNTO)
        .then(d => { conjuntos = d.data || []; })
        .catch(e => graphGet('/' + ACCOUNT + '/adsets?fields=' + CAMPOS_CONJUNTO_MINIMO)
          .then(d => { conjuntos = d.data || []; conjuntosErro = e.message + ' (campos reduzidos)'; })
          .catch(() => { conjuntosErro = e.message; })),
      graphGet('/' + ADSET_CONSOLIDADO + '/ads?fields=name,status,effective_status')
        .then(d => { anunciosConsolidado = d.data || []; })
        .catch(e => { anunciosErro = e.message; })
    ]);

    // ---- KPIs ----
    const gasto = totais ? num(totais.spend) : 0;
    const leads = totais ? extrairLeads(totais.actions) : 0;
    const kpis = {
      gasto,
      impressoes: totais ? num(totais.impressions) : 0,
      cliques: totais ? num(totais.clicks) : 0,
      ctr: totais ? num(totais.ctr) : 0,
      cpm: totais ? num(totais.cpm) : 0,
      leads,
      cpl: leads > 0 ? Math.round((gasto / leads) * 100) / 100 : null
    };
    if (totaisErro) kpis.erro = totaisErro;

    porDia = porDia.map(d => ({
      data: d.date_start,
      gasto: num(d.spend),
      impressoes: num(d.impressions),
      cliques: num(d.clicks),
      ctr: num(d.ctr),
      cpm: num(d.cpm),
      leads: extrairLeads(d.actions)
    }));

    porAnuncio = porAnuncio.map(a => {
      const g = num(a.spend);
      const l = extrairLeads(a.actions);
      const ad = anunciosConsolidado.find(x => x.name === a.ad_name);
      return {
        nome: a.ad_name,
        id: ad ? String(ad.id) : null,      // necessário para a ação pausar_anuncio
        gasto: g,
        impressoes: num(a.impressions),
        cliques: num(a.clicks),
        ctr: num(a.ctr),
        leads: l,
        cpl: l > 0 ? Math.round((g / l) * 100) / 100 : null,
        effective_status: ad ? ad.effective_status : null
      };
    });

    // ---- diagnóstico determinístico + achados qualificados ----
    const diagnostico = diagnosticar(kpis, porAnuncio, conjuntos, porDia, BASELINE);
    const achados = montarAchados(diagnostico, porAnuncio);

    // ---- redação pela IA (opcional: falha ou lista vazia não derruba nada) ----
    let redacao = null;
    let recomendacoesErro = null;
    if (achados.length) {
      try {
        redacao = await redigirAchados(diagnostico, achados);
      } catch (e) {
        recomendacoesErro = e.message;   // textos padrão gerados em código assumem
      }
    }
    const recomendacoes = montarRecomendacoes(achados, redacao);

    const body = {
      kpis,
      baseline: BASELINE,
      porDia,
      porAnuncio,
      conjuntos,
      anunciosConsolidado,
      recomendacoes,
      diagnostico,
      geradoEm: new Date().toISOString()
    };

    // quando não há nada a recomendar, explica o porquê em vez de encher a tela de ruído
    if (!recomendacoes.length) {
      body.semRecomendacoes = {
        motivo: diagnostico.temAmostra
          ? ('Volume insuficiente para qualquer leitura confiável: ' + diagnostico.gasto.toFixed(2).replace('.', ',') +
             ' reais gastos, ' + diagnostico.cliques + ' cliques e ' + diagnostico.leads +
             ' leads em ' + diagnostico.diasCorridos + ' dia(s). Diferenças observadas nesse volume são ruído estatístico, não sinal.')
          : 'Ainda não há gasto registrado no período — nada a analisar por enquanto.',
        gastoAteLeituraConfiavel: diagnostico.gastoAteLeituraConfiavel,
        diasAteLeitura: diagnostico.diasAteLeitura
      };
    }

    if (porDiaErro) body.porDiaErro = porDiaErro;
    if (porAnuncioErro) body.porAnuncioErro = porAnuncioErro;
    if (conjuntosErro) body.conjuntosErro = conjuntosErro;
    if (anunciosErro) body.anunciosConsolidadoErro = anunciosErro;
    if (recomendacoesErro) body.recomendacoesErro = recomendacoesErro;

    // salva o cache com as recomendações brutas (sem estado) e responde com o estado mesclado
    try { await blobPut('meta/insights-cache.json', { t: Date.now(), body }); } catch (e) { /* cache é melhor-esforço */ }

    const recs = await blobGet('meta/recs.json').catch(() => null);
    return res.status(200).json(Object.assign({}, body, {
      recomendacoes: mesclarEstado(recomendacoes, recs),
      cacheado: false
    }));
  } catch (e) {
    console.error('insights erro:', e.message);
    return res.status(500).json({ error: 'erro ao gerar insights', detalhe: e.message });
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
