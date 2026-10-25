/**
 * Conferencia do destino antes de enviar (SEG-M12-009).
 *
 * O bot nao executa cegamente o que a fila de saida manda. Hoje a fila so e
 * escrita pelo servidor, mas qualquer brecha do lado do app viraria mensagem
 * do numero compartilhado para qualquer pessoa ou grupo. Esta e a segunda
 * barreira, no proprio bot.
 */

const GRUPO = /^[0-9]+(-[0-9]+)?@g\.us$/;
// O app grava a mensagem privada com o telefone: so digitos e o sufixo do WhatsApp.
const PRIVADO = /^[0-9]{10,15}@s\.whatsapp\.net$/;

export function classificarJid(jid) {
  const j = String(jid || '');
  if (GRUPO.test(j)) return 'grupo';
  if (PRIVADO.test(j)) return 'privado';
  return 'invalido';
}

/**
 * Pode enviar para este jid?
 *  - grupo: so se estiver no mapa de grupos do bot (os da casa e os do roteamento);
 *  - privado: so se tiver o formato de telefone (o app grava lembrete pessoal
 *    e resumo da Coala assim, de proposito; a lista de telefones cadastrados
 *    ainda precisa vir do app, ver o registro do lote);
 *  - qualquer outra coisa (lista de transmissao, status, canal, @lid): nunca.
 */
export function destinoPermitido(jid, { gruposConhecidos }) {
  const tipo = classificarJid(jid);
  if (tipo === 'grupo') {
    return gruposConhecidos.has(jid) ? { ok: true, tipo } : { ok: false, tipo, motivo: 'grupo_fora_do_mapa' };
  }
  if (tipo === 'privado') return { ok: true, tipo };
  return { ok: false, tipo, motivo: 'jid_invalido' };
}

/** Tamanho maximo da figurinha baixada. */
export const LIMITE_FIGURINHA_BYTES = 512 * 1024;

const CAMINHO_DAS_FIGURINHAS = '/storage/v1/object/public/stickers/';

/**
 * Baixa a figurinha com todas as travas: endereco conferido, sem seguir
 * redirecionamento, com teto de tamanho (a figurinha inteira ia para a
 * memoria, sem limite, de qualquer endereco que o app mandasse).
 * `http` e o axios (ou um falso nos testes).
 */
export async function baixarFigurinhaSegura({ http, url, hosts = [] }) {
  const conferencia = urlDeFigurinhaPermitida(url, { hosts });
  if (!conferencia.ok) throw new Error(`figurinha recusada: ${conferencia.motivo}`);
  const r = await http.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: LIMITE_FIGURINHA_BYTES,
    maxBodyLength: LIMITE_FIGURINHA_BYTES,
    maxRedirects: 0,
  });
  const buffer = Buffer.from(r.data);
  if (buffer.length > LIMITE_FIGURINHA_BYTES) throw new Error('figurinha recusada: grande_demais');
  return buffer;
}

/**
 * A figurinha so e baixada do balde `stickers` do Supabase (ou de um host
 * que o dono liste em WA_STICKER_HOSTS), por https. Nada de endereco
 * interno, de outro dominio ou de caminho que nao seja o do balde.
 */
export function urlDeFigurinhaPermitida(url, { hosts = [], sufixos = ['.supabase.co'], caminho = CAMINHO_DAS_FIGURINHAS } = {}) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return { ok: false, motivo: 'url_invalida' };
  }
  if (u.protocol !== 'https:') return { ok: false, motivo: 'sem_https' };
  if (u.username || u.password) return { ok: false, motivo: 'credencial_na_url' };
  if (u.port && u.port !== '443') return { ok: false, motivo: 'porta_diferente' };
  const host = u.hostname.toLowerCase();
  const hostOk = hosts.includes(host) || sufixos.some((s) => host.endsWith(s) && host.length > s.length);
  if (!hostOk) return { ok: false, motivo: 'host_fora_da_lista' };
  if (!u.pathname.startsWith(caminho)) return { ok: false, motivo: 'caminho_fora_do_balde' };
  return { ok: true };
}
