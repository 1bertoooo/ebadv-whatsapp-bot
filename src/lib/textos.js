/**
 * Textos que o bot escreve por conta propria (o resto da fala da assistente
 * sai do app, com a marca e o vocabulario de cada organizacao).
 *
 * Sem exclamacao, com acento, e sem nome de pessoa nem de cliente.
 */

const MARCA_CAIXA_MARCADA = '\u2611\ufe0f';
const MARCA_AVISO = '\u26a0\ufe0f';

/** A apresentacao de sempre, corrigida (SEG-M12-020). Usada quando o app nao manda a dele. */
export function apresentacaoPadrao() {
  return (
    'Olá. Sou a Clio, a assistente do stabi.li. A partir de agora eu leio o que passa aqui ' +
    'e transformo em tarefa no painel de vocês. Para eu registrar alguma coisa, escreva assim:\n\n' +
    '*CLIENTE. o que precisa ser feito*\n\n' +
    `Quando eu registrar, marco a mensagem com ${MARCA_CAIXA_MARCADA}.`
  );
}

/**
 * A apresentacao com o aviso de privacidade (LGPD-002). So existe com o
 * endereco da politica na configuracao: o texto nunca leva endereco inventado.
 *
 * Antes de ligar: a frase "o texto das mensagens fica guardado" precisa
 * continuar verdadeira e o prazo de guarda (D08) entra aqui quando decidido.
 * O texto final passa por advogado (D01).
 */
export function apresentacaoComAviso({ urlDaPrivacidade }) {
  if (!urlDaPrivacidade) throw new Error('aviso de privacidade sem endereco da politica');
  return (
    'Olá. Sou a Clio, a assistente do stabi.li. Leio as mensagens deste grupo para transformar em tarefa ' +
    'as que seguem este formato:\n\n' +
    '*CLIENTE. o que precisa ser feito*\n\n' +
    'O texto das mensagens fica guardado no painel do escritório. Para me tirar, é só me remover do grupo. ' +
    `Como tratamos os dados: ${urlDaPrivacidade}\n\n` +
    `Quando eu registrar uma tarefa, marco a mensagem com ${MARCA_CAIXA_MARCADA}.`
  );
}

const TETO_DA_APRESENTACAO_DO_APP = 1500;

/**
 * O texto de entrada no grupo. Ordem: o que o app mandar no pedido
 * (`payload.apresentacao`, com a marca e o ramo do escritorio), depois o
 * aviso de privacidade se estiver ligado, depois o texto padrao.
 */
export function textoDeEntrada({ apresentacaoDoApp, avisoDeEntrada, urlDaPrivacidade }) {
  if (typeof apresentacaoDoApp === 'string' && apresentacaoDoApp.trim()) {
    return { texto: apresentacaoDoApp.trim().slice(0, TETO_DA_APRESENTACAO_DO_APP), origem: 'app' };
  }
  if (avisoDeEntrada && urlDaPrivacidade) {
    return { texto: apresentacaoComAviso({ urlDaPrivacidade }), origem: 'aviso' };
  }
  return { texto: apresentacaoPadrao(), origem: 'padrao' };
}

function megabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');
}

/** Resposta no grupo quando o arquivo passa do limite (SEG-M12-004). */
export function avisoDeArquivoGrande({ tamanho, limite }) {
  const quanto = tamanho ? `Esse arquivo tem ${megabytes(tamanho)} MB e passa` : 'Esse arquivo passa';
  return (
    `${MARCA_AVISO} ${quanto} do limite de ${megabytes(limite)} MB que consigo receber por aqui, ` +
    'então não registrei. Anexe pelo painel ou mande uma versão menor.'
  );
}

export const REACAO_DE_AVISO = MARCA_AVISO;
