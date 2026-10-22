#!/bin/bash
# Põe a voz da Luana no bot do WhatsApp (VPS Miami).
#
# Rodar no Terminal do Mac (pede a senha do root do VPS):
#   ssh root@23.95.79.192 'bash -s' < ~/Controle/_ops/luana/atualizar-voz.sh
#
# O que faz, em ordem:
# 1. instala o ffmpeg (deixa o áudio da Luana no formato exato da nota de
#    voz do WhatsApp e mede a duração; sem ele o bot manda o áudio como vem);
# 2. instala o código do bot com a nota de voz (commit d0e9e39), só se o
#    arquivo do VPS for o da versão anterior conhecida e o download conferir
#    byte a byte; o de antes fica guardado ao lado, com a data no nome;
# 3. reinicia o bot e diz se conectou.
#
# Para voltar atrás: copie o index.js.antes-<data> por cima do index.js e
# rode `systemctl restart luana-bot`.
set -u
APP=/opt/ebadv-whatsapp-bot
LOG=/var/log/luana-bot.log
UNIT=luana-bot
SHA_ANTERIOR=a22185862da5defb6b51eb013568114ff574c155618727fe5fb0139e875dba32
SHA_NOVO=253b495b6292eadb680d7f22ace482202bc53d92aab529f4457cbfe37fd642d3
COMMIT=d0e9e3908502639d5e3bcbdd644f3575ff1f6ddd

linhas_do_log() { wc -l < "$LOG" 2>/dev/null || echo 0; }
log_desde() { tail -n +"$(( $1 + 1 ))" "$LOG" 2>/dev/null; }

echo "=== 1. ffmpeg"
if command -v ffmpeg >/dev/null 2>&1; then
  echo "já estava instalado: $(ffmpeg -version 2>/dev/null | head -1)"
else
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1
  if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null 2>&1; then
    echo "instalado: $(ffmpeg -version 2>/dev/null | head -1)"
  else
    echo "não consegui instalar o ffmpeg; a voz funciona mesmo assim (o áudio vai como vem do LIS)"
  fi
fi
df -h / | tail -1

echo
echo "=== 2. código do bot com a nota de voz"
ATUAL=$(sha256sum "$APP/src/index.js" | cut -d' ' -f1)
if [ "$ATUAL" = "$SHA_NOVO" ]; then
  echo "já estava no código novo"
elif [ "$ATUAL" = "$SHA_ANTERIOR" ]; then
  if curl -fsSL "https://raw.githubusercontent.com/1bertoooo/ebadv-whatsapp-bot/$COMMIT/src/index.js" -o /tmp/index.js.voz \
     && [ "$(sha256sum /tmp/index.js.voz | cut -d' ' -f1)" = "$SHA_NOVO" ] \
     && node --check /tmp/index.js.voz; then
    cp "$APP/src/index.js" "$APP/src/index.js.antes-$(date +%Y%m%d%H%M)"
    cp /tmp/index.js.voz "$APP/src/index.js"
    echo "código novo instalado (o de antes ficou ao lado, com a data no nome)"
  else
    echo "o download não conferiu: ficou o código de antes, nada mudou"
    exit 1
  fi
else
  echo "o index.js do VPS não é a versão que eu conheço (sha $ATUAL): não troquei, nada mudou"
  exit 1
fi

echo
echo "=== 3. reiniciando"
MARCA=$(linhas_do_log)
systemctl restart "$UNIT"
ESTADO="sem resposta em 60 s"
for _ in $(seq 1 12); do
  sleep 5
  NOVO=$(log_desde "$MARCA")
  if echo "$NOVO" | grep -q "conectado ao WhatsApp"; then ESTADO="CONECTADA"; break; fi
  if echo "$NOVO" | grep -qi "logged out"; then ESTADO="DESLOGADA"; break; fi
done
log_desde "$MARCA" | cut -c1-200 | tail -12
echo
echo ">>> $ESTADO ($(systemctl is-active "$UNIT"))"
if [ "$ESTADO" = "DESLOGADA" ]; then
  echo "O WhatsApp deslogou a Luana. Rode: ssh root@23.95.79.192 'bash -s' < ~/Controle/_ops/luana/parear.sh"
elif [ "$ESTADO" = "CONECTADA" ]; then
  echo "Pronto. Mande um áudio no EBADV. Captura falando \"Luana\" para testar."
fi
