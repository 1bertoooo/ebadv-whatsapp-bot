/**
 * Leitura da configuracao a partir das variaveis de ambiente.
 *
 * Funcao pura: recebe o objeto de ambiente e devolve a configuracao ja
 * validada, para o teste poder variar o ambiente sem tocar em process.env.
 */

/** "a;b, c" vira ['a', 'b', 'c']. */
export function listaDe(valor, separadores = /[;,]/) {
  return String(valor || '')
    .split(separadores)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function inteiroPositivo(valor, padrao) {
  const n = Number.parseInt(String(valor ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

/** 1, true, sim, ligado e on ligam; qualquer outra coisa (inclusive vazio) desliga. */
export function ligado(valor) {
  return /^(1|true|sim|ligado|on)$/i.test(String(valor ?? '').trim());
}

/**
 * Endereco base do app, tirado do endereco da captura. Uma funcao so para
 * todas as chamadas: antes havia duas maneiras de cortar, e com barra no
 * fim o aviso de deslogado ia para o endereco errado.
 */
export function baseDoLis(urlDaCaptura) {
  return String(urlDaCaptura || '')
    .trim()
    .replace(/\/api\/whatsapp\/.*$/, '')
    .replace(/\/+$/, '');
}

/** Um endereco https valido, ou ''. Nunca inventa endereco. */
export function urlHttpsOuVazio(valor) {
  const texto = String(valor || '').trim();
  if (!texto) return '';
  try {
    const u = new URL(texto);
    return u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

const SUFIXO_DE_GRUPO = '@g.us';

export function lerConfig(env = {}) {
  const lisUrl = String(env.LIS_CAPTURE_URL || '').trim();
  const aviso = ligado(env.WA_AVISO_ENTRADA);
  const urlDaPrivacidade = urlHttpsOuVazio(env.WA_URL_PRIVACIDADE);

  const mb = inteiroPositivo(env.WA_LIMITE_ARQUIVO_MB, 3);

  return {
    lisUrl,
    lisBase: baseDoLis(lisUrl),
    segredo: String(env.LIS_CAPTURE_SECRET || ''),

    // Grupos da casa. O jid e o que vale; o nome so serve para descobrir o
    // jid uma vez (ver resolverGruposDaCasa) e depois nao decide mais nada.
    nomesDosGrupos: listaDe(env.WA_GROUP_NAMES || env.WA_GROUP_NAME || 'EBADV. Captura', ';'),
    jidsDosGrupos: listaDe(env.WA_GROUP_JIDS).filter((j) => j.endsWith(SUFIXO_DE_GRUPO)),

    authDir: env.WA_AUTH_DIR || './auth_state',
    estadoDir: env.WA_ESTADO_DIR || './estado',
    logLevel: env.LOG_LEVEL || 'info',
    telefoneDoChip: String(env.WA_PHONE_NUMBER || '').replace(/\D/g, ''),
    numeroId: String(env.WA_NUMERO_ID || ''),

    // Ligado so depois que o app novo (o vigia e a fila de saida lendo a linha
    // do chip) estiver no ar. Ver registro do lote BOTS, SEG-M12-015.
    enviarNumeroId: ligado(env.WA_ENVIAR_NUMERO_ID),

    // Aviso de privacidade na mensagem de entrada (LGPD-002). Desligado ate a
    // politica estar publicada (D01). Ligado sem endereco valido nao liga.
    avisoDeEntrada: aviso && urlDaPrivacidade !== '',
    avisoPedidoSemEndereco: aviso && urlDaPrivacidade === '',
    urlDaPrivacidade,

    // Arquivo: o corpo de uma requisicao no app para em 4,5 MB e o base64
    // cresce um terco, entao 3 MB e o teto seguro por arquivo.
    limiteDeArquivoBytes: mb * 1024 * 1024,

    visualizacaoUnica: /^capturar$/i.test(String(env.WA_VISUALIZACAO_UNICA || '')) ? 'capturar' : 'ignorar',
    enviarEdicoes: ligado(env.WA_ENVIAR_EDICOES),

    // Hosts de onde a figurinha pode ser baixada, alem de *.supabase.co.
    hostsDeFigurinha: listaDe(env.WA_STICKER_HOSTS).map((h) => h.toLowerCase()),

    // Tempos (ms).
    timeoutDaCapturaMs: inteiroPositivo(env.LIS_TIMEOUT_S, 280) * 1000,
    intervaloDePedidosMs: inteiroPositivo(env.WA_PEDIDOS_INTERVALO_S, 15) * 1000,
    pedidosRapidoMs: 3000,
    pedidosRapidoPorMs: 3 * 60_000,

    // Fila local em disco.
    filaMaxItens: inteiroPositivo(env.WA_FILA_MAX_ITENS, 500),
    filaMaxBytes: inteiroPositivo(env.WA_FILA_MAX_MB, 64) * 1024 * 1024,
    filaEntradaValidadeMs: inteiroPositivo(env.WA_FILA_ENTRADA_HORAS, 24) * 3600_000,
    filaSaidaValidadeMs: inteiroPositivo(env.WA_FILA_SAIDA_HORAS, 6) * 3600_000,

    // Ritmo de envio da fila de saida (o resto fica fora: resposta a quem escreveu tem prioridade).
    saidaPorMinuto: inteiroPositivo(env.WA_SAIDA_POR_MINUTO, 10),
    saidaPorHora: inteiroPositivo(env.WA_SAIDA_POR_HORA, 100),
  };
}
