# whatsapp-rh-bot-demo

Projeto **demonstrativo** de um chatbot interno de RH para WhatsApp, com **handover para atendimento humano** e **painel admin** (estilo WhatsApp) com atualização em tempo real.

> **Importante:** este repositório é uma versão **genérica/demonstrativa**, sem dados, tokens, domínios ou informações de empresa.

## Principais funcionalidades
- Fluxo de menu e atendimento automatizado
- Captura de nome antes do handover (quando necessário)
- Fila interna (posição visível apenas no admin)
- Painel `/admin` com histórico em ordem cronológica
- Atendimento humano: assumir, responder e encerrar
- Notificação por e-mail ao entrar na fila (opcional)
- Atualização em tempo real (SSE + fallback)

## Stack
- Node.js
- Express
- Axios
- dotenv
- Nodemailer

## Como rodar localmente
1. Instale dependências:
   ```bash
   npm install
   ```

2. Crie seu `.env` a partir do exemplo:
   ```bash
   copy .env.example .env
   ```
   (no PowerShell: `Copy-Item .env.example .env`)

3. Preencha as variáveis no `.env` e rode:
   ```bash
   npm start
   ```

## Rotas úteis
- `GET /webhook` — verificação do webhook (Meta)
- `POST /webhook` — recebimento de mensagens
- `GET /admin` — painel administrativo
- `GET /test-message` — envio de teste (requer `TEST_NUMBER` no `.env`)

## Segurança
- **Não** faça commit do `.env`
- Não publique tokens, e-mails ou URLs internas
- Se quiser tornar público: revise mensagens/textos para evitar qualquer referência sensível
