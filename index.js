//-------------------------------------------------------------------------------------------------Carregamento do .env (variáveis como: email, senhas, tokens)-------------------------------
require("dotenv").config(); 

//-------------------------------------------------------------------------------------------------Importando as bibliotecas------------------------------------------------------------------
//cria o servidor que permite "falar com o BOT"
const express = require("express"); 
//é o mensageiro usado para "chamar/ligar" a API do WhatsApp na Meta).
const axios = require("axios"); 
//biblioteca para envio de e-mails via SMTP, usado quando alguem entra na fila.
const nodemailer = require("nodemailer"); 
//-------------------------------------------------------------------------------------------------Inicializa o app Express.-----------------------------------------------------------------
const app = express(); //Cria um servidor e aceita mensagens em formato JSON.
app.use(express.json());

//-------------------------------------------------------------------------------------------------Logs de diagnóstico para conferir se as variáveis chegaram.-------------------------------
 /* 1ºMostra qual e-mail está sendo usado pra enviar
    2ºconfirma se a senha existe (sem mostrar a senha)
    3ºremove espaços invisíveis
    4ºevita erro besta tipo: “senha errada” (quando na verdade era um espaço)
  */
if (process.env.DEBUG === "1") {
  console.log("SMTP_USER:", (process.env.SMTP_USER||"").trim());
  console.log("SMTP_PASS len:", (process.env.SMTP_PASS||"").trim().length);
}

//-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const PORT = process.env.PORT || 3000; //porta onde o servidor está rodando
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim(); // token de validação na Meta (defina no .env)

//-------------------------------------------------------------------------------------------------Delay para deixar o Bot mais "Humano"----------------------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));//Coloca o Bt para “dormir” por ms milissegundos.

// ===============================
// CONTROLE DE ENVIO (ANTI-RATE-LIMIT)
// ===============================
// WhatsApp Cloud pode retornar: (#131056) pair rate limit hit.
// Para reduzir isso: fila por destinatário + intervalo mínimo entre envios.
const sendQueues = new Map(); // to -> Promise chain
const lastSentAt = new Map(); // to -> timestamp ms
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS || 900); // ajuste fino se necessário

function enqueueSend(to, fn) {
  const prev = sendQueues.get(to) || Promise.resolve();
  const next = prev
    .catch(() => {}) // não quebra a fila se um envio falhar
    .then(async () => {
      const last = lastSentAt.get(to) || 0;
      const gap = Date.now() - last;
      if (gap < MIN_GAP_MS) await wait(MIN_GAP_MS - gap);
      const r = await fn();
      lastSentAt.set(to, Date.now());
      return r;
    });
  sendQueues.set(to, next);
  return next;
}

// Trata rate limit específico (#131056)
function isPairRateLimit(err) {
  const data = err?.response?.data;
  const code = data?.error?.code;
  return code === 131056;
}


async function postWithRetry(url, body, options, attempts = 2) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await axios.post(url, body, options);
    } catch (e) {
      lastErr = e;
      if (i < attempts) await wait(350);
    }
  }
  throw lastErr;
}


//-------------------------------------------------------------------------------------------------Envio da mensagem de texto bot via WhatsApp Cloud API---------------------------------------
/*
1ºMonta o endereço da Meta
2ºDiz pra quem mandar
3ºDiz o que mandar
4ºUsa o token secreto
5ºEnvia
*/
async function sendText(to, text) {
  const url = `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };
  const headers = {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };

  return enqueueSend(to, async () => {
    try {
      await postWithRetry(url, body, { headers }, 2);
      try { logMessage(to, "bot", text); } catch (e) {}
    } catch (e) {
      // Se estourou rate limit, loga e não tenta disparar em loop
      const data = e?.response?.data;
      if (isPairRateLimit(e)) {
        console.error("⚠️ Rate limit (#131056) ao enviar. Aguarde alguns segundos e tente novamente.");
      } else {
        console.error("Erro ao enviar:", data || e.message);
      }
    }
  });
}

//-------------------------------------------------------------------------------------------------Envio da mensagem de texto humano via WhatsApp Cloud API(painel /admin)-------------
/*
1ºMonta o endereço da Meta
2ºDiz pra quem mandar
3ºDiz o que mandar
4ºUsa o token secreto
5ºEnvia
*/

async function sendHumanText(to, text) {
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };
  const headers = {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };

  return enqueueSend(to, async () => {
    try {
      await postWithRetry(url, body, { headers }, 2);
      try { logMessage(to, "human", text); } catch (e) {}
    } catch (e) {
      const data = e?.response?.data;
      if (isPairRateLimit(e)) {
        console.error("⚠️ Rate limit (#131056) ao enviar (humano). Aguarde alguns segundos.");
      } else {
        console.error("Erro ao enviar (humano):", data || e.message);
      }
    }
  });
}


//-------------------------------------------------------------------------------------------------iniciar conversa com alguém que ainda não falou com o bot---------------------------

//Essa função serve para iniciar uma conversa com alguém que ainda não falou com o bot, ou que ficou mais de 24 horas sem responder.

async function sendHelloWorldTemplate(to) {
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;//url da meta
  const body = {//corpo da mensagem
    messaging_product: "whatsapp",
    to,
    type: "template",//o tipo da mensagem é um template
    template: {// mensagem modelo aprovada pela meta
      name: "hello_world",
      language: { code: "en_US" },
    },
  };
  const headers = {//cabeçario da função, mesma identidade, mesmo token
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
  // retorna a resposta para o caller poder validar no endpoint de teste
  return axios.post(url, body, { headers });
}

//------------------------------------------------------------------------------------LISTA DE MENUS PRINCIPAIS---------------------------------------------------------------------------------------

// Mensagem de Saudação
const WELCOME_1 = "Olá 👋, eu sou o assistente virtual do RH.";

//Menu principal
const ROOT_MENU = [
  "O que você deseja fazer hoje?",
  "",
  "1️⃣ Informações sobre Ponto (Multi / My Ahgora)",
  "",
  "2️⃣ Folha & Benefícios (Meu RH)",
  "",
  "3️⃣ Dúvidas sobre holerite",
  "",
  "4️⃣ Falar com atendente",
].join("\n");

// Menu 1 Informações sobre Ponto (Multi / My Ahgora)
const PONTO_MENU = [
  "Por favor, escolha uma opção:",
  "",
  "1️⃣ Registrar ponto",
  "",
  "2️⃣ Consultar ponto",
  "",
  "3️⃣ Solicitar abonamento de horas",
  "",
  "4️⃣ Cancelar batida de ponto",
  "",
  "5️⃣ Incluir batida de ponto",
  "",
  "6️⃣ Enviar atestado",
  "",
  "7️⃣ Falar com atendente",
  "",
  "8️⃣ Retornar ao menu inicial",
].join("\n");
// Menu 2 Folha & Benefícios (Meu RH / TOTVS)
const FOLHA_MENU = [
  "Por favor, escolha uma opção:",
  "",
  "1️⃣ Acessar histórico de pagamentos",
  "",
  "2️⃣ Consultar histórico salarial",
  "",
  "3️⃣ Consultar informe de rendimentos",
  "",
  "4️⃣ Falar com atendente",
  "",
  "5️⃣ Retornar ao menu inicial",
].join("\n");
//------------------------------------------------------------------------------------LISTA DE PASSO A PASSO SUBMENU 1 (PONTO)---------------------------------------------------------------------------------------

const PASSO_ATESTADO = [
  "*Passo a passo para enviar atestado:*",
  "",
  "🔷 Abra o app ou portal Meu RH e faça login com seu usuário e senha.",
  "🔷 Acesse a aba *Atestado* na parte inferior da tela.",
  "🔷 Preencha as informações: solicitadas, que correspondem aos dados presentes no atestado médico, como o tipo de atestado e o motivo de afastamento (Atestado Médico Faltas Justificadas).",
  "🔷 Anexe o documento: Toque em *Anexar Arquivo* para anexar a foto do atestado ou um documento escaneado em formato PDF.",
  "🔷 Escreva uma justificativa explicativa sobre o atestado.",
  "🔷 Confirme o envio para que o processo seja concluído e o atestado encaminhado ao departamento de Recursos Humanos.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ (link do tutorial)
].join("\n");

const PASSO_HIST_PAGAMENTOS = [
  "*Passo a passo para acessar histórico de pagamentos:*",
  "",
  "🔷 Abra: o aplicativo Meu RH e faça o login.",
  "🔷 Acesse a aba «Pagamentos» na parte inferior da tela.",
  "🔷 Selecione *Envelope de Pagamento*: A partir daí, selecione a opção *Envelope de Pagamento*.",
  "🔷 Escolha o período desejado: O seu envelope de pagamentos estará disponível para visualização e poderá baixar o documento em formato PDF.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ (link do tutorial)
].join("\n");

const PASSO_HIST_SALARIAL = [
  "*Passo a passo para consultar o histórico salarial:*",
  "",
  "🔷 Abra o app ou portal Meu RH e faça login com seu usuário e senha.",
  "🔷 Acesse a aba *Pagamentos* na parte inferior da tela",
  "🔷 Acesse *Histórico Salarial*",
  "🔷 Ao acessar esta seção, o aplicativo deve exibir o seu histórico salarial desde a admissão, detalhando alterações salariais, como promoções e reajustes.",
  "",
  "*Obs:* Utilize Filtros (se necessário) para buscar por um período específico (início e fim) ou por um motivo de alteração específico.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ (link do tutorial)
].join("\n");

const PASSO_INFORME = [
  "*Passo a passo para consultar informe de rendimentos*",
  "",
  "🔷 Abra o app ou portal Meu RH e faça login com seu usuário e senha.",
  "🔷 Acesse a aba *Pagamentos* na parte inferior da tela.",
  "🔷 Acesse *Informe de Rendimentos*",
  "🔷 Ao clicar nesta opção, você poderá consultar, baixar ou até mesmo compartilhar o seu informe de rendimentos diretamente pelo aplicativo.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ (link do tutorial)
].join("\n");

//------------------------------------------------------------------------------------MENSAGENS DE FINALIZAÇÃO ---------------------------------------------------------------------------------------

// Mensagem enviada após o envio dos tutoriais
const ASK_BACK = "Deseja voltar ao Menu Inicial?\n\nSim\n\nNão";

//Mensagem de encerramento de uma conversa por inatividade ou pelo usuário
const THANKS = "Atendimento encerrado. Obrigado por entrar em contato com o RH! Se precisar de mais informações, é só mandar uma nova mensagem. 😉";

//Mensagem enviada quando o Bot está em estado hanover (inativo) e o usuário envia uma nova mensagem
const ASK_HANDOVER = "Como posso te ajudar agora?\n\n1️⃣ Retornar ao Menu inicial\n\n2️⃣ Aguardar o atendimento humano";

//------------------------------------------------------------------------------------ENVIO DOS MENUS PRINCIPAL E SUBMENU PONTO-------------------------------------------------------------------------
// Envia saudação + menu principal (com intervalo de 1s)
async function sendWelcomeAndMenu(to) {
  //envia a mensagem pelo WhatsApp para "to", que é o número do destinatário
  await sendText(to, WELCOME_1);
  //pausa por 1 segundo antes de mandar o menu, pra conversa parecer mais natural.
  await wait(1000); 
  //envia a mensagem pelo WhatsApp.
  lastMenuCtx.set(to, { menu: "root", ts: Date.now() });
  await sendText(to, ROOT_MENU); 
}

// Envia o menu principal (sem saudação)
async function sendRootMenu(to) {
  lastMenuCtx.set(to, { menu: "root", ts: Date.now() });
  lastMenuCtx.set(to, { menu: "root", ts: Date.now() });
  await sendText(to, ROOT_MENU);
}

// Envia submenu do ponto
async function sendPontoMenu(to) {
  lastMenuCtx.set(to, { menu: "ponto", ts: Date.now() });
  await sendText(to, PONTO_MENU);
}
//------------------------------------------------------------------------------------LISTA DE PASSO A PASSO SUBMENU 1 (BENEFICIOS)---------------------------------------------------------------------------------------

const PASSO_REGISTRAR = [
  "*Passo a passo para bater o ponto:*",
  "",
  "🔷 No seu smartphone, abra a aplicativo Multi.",
  "🔷 Na tela inicial do aplicativo, procure pelo botão *REGISTRAR PONTO*,","que permite registrar o ponto.",
  "🔷 Coloque a senha do smartphone para realizar a batida do ponto",
  "🔷 Após a confirmação da sua batida, um comprovante de ponto poderá ser fornecido.",
  "Sincronização offline: Caso não haja conexão de internet, o aplicativo permitirá fazer o registro normalmente,",
  "e os dados serão enviados automaticamente para os servidores assim que o sinal for restabelecido.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ (link do tutorial)
].join("\n");

const PASSO_ESPELHO = [
  "*Passo a passo para acessar o espelho de ponto:*",
  "",
  "🔷 Na tela de login do aplicativo, insira o código da empresa, sua matrícula e senha, e toque em *Entrar*.",
  "🔷 Após o login, você será direcionado para a tela inicial do aplicativo.",
  "🔷 Toque em *Acessar espelho detalhado* para ver as informações do ponto.",
  "🔷 Toque no botão *Trocar competência*, localizado na parte superior esquerda do aplicativo.",
  "🔷 Escolha o período: Selecione o ano e mês do qual deseja visualizar o espelho de ponto e toque em *Ok*.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ (link do tutorial)
].join("\n");

const PASSO_ABONO = [
  "*Passo a passo para solicitar um abono:*",
  "",
  "🔷 Abra o aplicativo My Ahgora em seu smartphone.",
  "🔷 Na página inicial toque em *Solicitar abono*.",
  "🔷 Preencha os dados do abono:",
  "   ▫️ Selecione o Motivo do abono",
  "   ▫️ Selecione o período",
  "🔷 Digite uma mensagem para o seu gestor ou RH no campo Mensagem justificando o abonamento.",
  "🔷 Toque em *Adicionar anexo* para selecionar e anexar o arquivo da sua justificativa (como um atestado médico).",
  "🔷 Toque em *Enviar Solicitação de abono* para que o pedido seja encaminhado ao gestor para aprovação.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ (link do tutorial)
].join("\n");

const PASSO_CANCELAR_BATIDA = [
  "*Passo a passo para solicitar o cancelamento de uma batida de ponto*",
  "",
  "⚠️ O Cancelamento da batida só pode ser realizado no mesmo  dia da marcação",
  "",
  "🔷 Acesse o aplicativo: Abra o aplicativo My Ahgora em seu smartphone.",
  "🔷 Inicie a solicitação: Toque em *Cancelar Batida*",
  "🔷 Selecione o horário que deseja desconsiderar",
  "🔷 Selecione o motivo",
  "🔷 Adicione uma mensagem: Digite uma mensagem para o seu gestor ou RH no campo Mensagem obrigatória.",
  "🔷 Envie a solicitação: Toque em *Incluir batida* para que o pedido seja encaminhado ao gestor para aprovação.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ (link do tutorial)
].join("\n");

const PASSO_INCLUIR = [
  "*Passo a passo para solicitar a inclusão de uma batida de ponto*",
  "",
  "🔷 Acesse o aplicativo: Abra o aplicativo My Ahgora em seu smartphone.",
  "🔷 Inicie a solicitação: Toque em *Incluir Batida*",
  "🔷 Selecione a data que deseja incluir a batida",
  "🔷 Selecione o horário que deseja incluir",
  "🔷 Selecione o motivo",
  "🔷 Adicione uma mensagem: Digite uma mensagem para o seu gestor ou RH no campo Mensagem obrigatória.",
  "🔷 Envie a solicitação: Toque em *Incluir batida* para que o pedido seja encaminhado ao gestor para aprovação.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ (link do tutorial)
].join("\n");

//------------------------------------------------------------------------------------ENVIO PARA ATENDIMENTO HUMANO ---------------------------------------------------------------------------------------

//Mensagem de envio para atendente
function handoverMsg(_position){//posição do usuário na fila de chamados

  // Função que devolve um texto pronto, mas sem informar ao usuário a posição dele na fila(a posição aparece somente no painel /admin)
  return `🔄 Encaminhando para um atendente humano. Nosso time responderá em até 24 horas.`;
}

// é um "apelido", Em vez de o código chamar handoverMsg(...), ele pode chamar PASSO_ATENDENTE
const PASSO_ATENDENTE = handoverMsg;

//memória que lembra em que ponto da conversa o usuário está.
const state = new Map();
const lastMenuCtx = new Map(); // { waId: { menu: "root"|"ponto"|"folha", ts: number } }


function setState(waId, newState) {
  state.set(waId, newState);
  broadcast("conversations", { at: nowISO() });
  broadcast("conversation", { waId, at: nowISO() });
}

//------------------------------------------------------------------------------------PAINEL ADMIN STORE (painel /admin)---------------------------------------------------------------------------------
// Guarda nome do usuário (coletado antes do atendimento humano)
const userNames = new Map();

// Histórico de mensagens para o painel
const convoStore = new Map();

// SSE clients para atualização em tempo real (fica atualizando o navegador)
const sseClients = new Map();
let sseSeq = 1;

//gera uma data padrão pra "marcar horário"
function nowISO() { return new Date().toISOString(); }

//Garante que a conversa existe para aquele número
function getConvo(waId) {
  if (!convoStore.has(waId)) {
    convoStore.set(waId, { waId, messages: [], unread: 0, lastMessageAt: null, lastUserMessageAt: null });
  }
  return convoStore.get(waId);
}
//É o “formato” que o navegador entende no SSE
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

//Atualiza o Painel de todos que estão com ele aberto
function broadcast(event, data) {
  for (const res of sseClients.values()) {
    try { sseSend(res, event, data); } catch (e) {}
  }
}

//marca a conversa como lida quando assume o atendimento
function markRead(waId) {
  const c = getConvo(waId);
  c.unread = 0;
  broadcast("conversations", { at: nowISO() });
  broadcast("conversation", { waId, at: nowISO() });
}

/*
Pega a conversa desse usuário (getConvo)
Monta um objeto mensagem com:
horário (ts), quem falou (from),texto (text)
Adiciona no histórico (messages.push)
Atualiza “última mensagem”
Se quem falou foi o usuário:
aumenta “não lidas”
atualiza “última mensagem do usuário”
E no final, manda atualização ao vivo pro painel (broadcast)
.*/
function logMessage(waId, fromWho, text) {
  const c = getConvo(waId);
  const msg = { ts: nowISO(), from: fromWho, text: (text ?? "").toString() };
  c.messages.push(msg);
  c.lastMessageAt = msg.ts;
  if (fromWho === "user") {
    c.lastUserMessageAt = msg.ts;
    c.unread = (c.unread || 0) + 1;
  }
  broadcast("conversation", { waId, at: nowISO() });
  broadcast("conversations", { at: nowISO() });
}


//------------------------------------------------------------------------------------FLUXO MENU 3 (DÚVIDA SOBRE HOLERITE) ---------------------------------------------------------------------------------------

//é uma meméria temporária, para bot saber, para cada pessoa, em que ponto do envio do holerite ela esta
const holeriteSessions = new Map(); 

//Define o tempo antes de o bot encaminhar para o atendimento humano após receber a mensagem e o print do holerit
const HOLERITE_FORWARD_MS = 03* 1000; // 3 segundos

//Essa função limpa o temporizador da sessão do usuário(tempo de inatividade).
function clearHoleriteTimer(from) {
  const sess = holeriteSessions.get(from);//pega a sessão do número específico.
  if (sess?.forwardTimer) { //verifica se há um timer ativo.
    clearTimeout(sess.forwardTimer); //cancela o timer, evitando que ele dispare automaticamente (por exemplo, se o usuário já mandou tudo e o bot não precisa mais encaminhar).
    sess.forwardTimer = null;//garante que o campo fique “zerado”.
  }
}

//------------------------------------------------------------------------------------ ENVIO PARA ATENDIMENTO HUMANO ---------------------------------------------------------------------------------------
/*responsável por agendar o encaminhamento automático do caso para um atendente humano,
  caso o usuário não envie tudo o que é necessário (texto + imagem) no tempo limite.*/
function armHoleriteForward(from) {
   clearHoleriteTimer(from);

  //Recupera a sessão atual do usuário (se existir) a partir do holeriteSessions
  const sess = holeriteSessions.get(from) || { hasText: false, hasImage: false, forwardTimer: null };

  //Aqui ele cria o temporizador (setTimeout) que vai rodar depois do tempo definido
  sess.forwardTimer = setTimeout(async () => {
    const __name = (userNames.get(from) || "").toString().trim();
    if (!__name) {
      await sendText(from, "Antes de falar com um atendente, me diga seu nome, por favor 🙂");
      state.set(from, "await_human_name");
      return;
    }

    const __pos = enqueueHandover(from);
    await sendText(from, handoverMsg(__pos));
    setState(from, "handover");
    stopInactivity(from); // não encerrar por inatividade durante handover

//------------------------------------------------------------------------ ORDEM DE CHAMADOS ENCAMINHADOS PARA ATENDIMENTO HUMANO ----------------------------------------------------------------------------

//Esse trecho tenta enfileirar e notificar o RH por email sobre o novo atendimento
    try {
      const position = enqueueHandover(from); //adiciona o usuário à fila de atendimento humano e retorna a posição (ex.: 1º da fila, 2º, etc.).
      await notifyRH({ from, position }); //envia um e-mail ou alerta interno pro time do RH avisando:
    } catch (err) {
      console.error("Falha ao notificar RH:", err?.message || err);
    }

  }, HOLERITE_FORWARD_MS);//é o tempo de espera definido anteriormente(5 segundos)
  holeriteSessions.set(from, sess);
}

//----------------------------------------------------------------------------------------- CONTROLE DE INATIVIDADE ----------------------------------------------------------------------------------------

const inactivityTimers = new Map(); //guarda um timer por usuário pra detectar quem não interagiu mais
const INACTIVITY_MS = 3 * 60 * 1000; // 3 minutos

//Serve pra cancelar o contador de inatividade de um usuário específico.
function stopInactivity(from) {
  if (inactivityTimers.has(from)) { //verifica se o timer existe.
    clearTimeout(inactivityTimers.get(from)); //para o cronômetro.
    inactivityTimers.delete(from); //remove o registro do mapa.
  }
}

/*toda vez que o usuário interage com o bot (manda uma nova mensagem).
A função “reinicia” o cronômetro de inatividade daquele número.*/
function resetInactivityTimer(from) {

    if (state.get(from) === "handover") return;// Se o usuário está em modo de atendimento humano (handover), o bot não cria o timer de inatividade.
  stopInactivity(from); //Cancela qualquer timer antigo de inatividade que esse número possa ter.

  const t = setTimeout(async () => { //Cria um novo temporizador (timer) e guarda a referência na variável t.

    const current = state.get(from); //Quando o tempo expira, o bot verifica novamente o estado
    if (current === "handover" || current === "ended") return;
        await sendText(from, THANKS); //Caso contrário, significa que o usuário ficou inativo, então:
    setState(from, "ended");
  }, INACTIVITY_MS); // Define o tempo de espera
  inactivityTimers.set(from, t);
}
//----------------------------------------------------------------------------------------- PADRONIZAÇÃO DE ENTRADA DE TEXTO ----------------------------------------------------------------------------------------

/*Garante que o texto de entrada seja tratado de forma padronizada, removendo variações.
Usada quando o bot precisa comparar respostas do usuário (“sim”, “Sim”, “ SIM ” → tudo vira “sim”).*/
async function safeSendText(to, text) {
  try {
    await sendText(to, text);
    return true;
  } catch (e) {
    return false;
  }
}

function normalize(txt) {
  return (txt || "").toString().trim().toLowerCase();
}

//----------------------------------------------------------------------------- CONFIGURAÇÃO ENVIO DE EMAIL PARA FILA DE CHAMADOS ------------------------------------------------------------------------------------

// Lê as credenciais do .env. para conseguir enviar o email
const smtpUser = (process.env.SMTP_USER || "").trim();//o e-mail usado para enviar as notificações
const smtpPass = (process.env.SMTP_PASS || "").replace(/\s+/g, "").trim(); //a senha de app do Gmail (não é a senha normal da conta).

//Cria o transporte SMTP (é o “canal” que envia os e-mails).
const mailer = nodemailer.createTransport({
  service: "gmail",//usa as configurações padrão do Gmail.
  auth: { user: smtpUser, pass: smtpPass },//autenticação com usuário e senha.
});

// Faz um teste automático ao iniciar o servidor com o gmail.
mailer.verify((err) => {
  if (err) {
    console.error("❌ SMTP verify FAILED:", err);//Se der erro (senha errada, autenticação bloqueada, etc.), o log mostra:
  } else {
    console.log("✅ SMTP verify OK");//Se as credenciais estiverem corretas, aparece no console:
  }
});

//Configura a lista de forma ordenada

const handoverQueue = []; // é um array (LISTA ORDENADA DE VALORES) que guarda a ordem de chegada dos usuários que estão esperando atendimento humano.
const inQueue = new Set(); //é um Set (estrutura sem duplicados) usado só pra evitar que o mesmo número entre na fila mais de uma vez.

//Verifica se o úsuário ja esta na fila

function enqueueHandover(from) {
  if (!inQueue.has(from)) { //Verifica se o número já está na fila
    inQueue.add(from);//Se não está, adiciona o número para marcá-lo como “em fila”,e também insere no array handoverQueue com o horário atual.
    handoverQueue.push({ from, ts: Date.now() }); //procura a posição (base 0), por isso soma +1 para deixar “base 1” (ex.: 1º, 2º, 3º).
  }
  broadcast("conversations", { at: nowISO() });

  broadcast("conversation", { waId: from, at: nowISO() });

  return handoverQueue.findIndex((x) => x.from === from) + 1; // posição 1-based
}

//Remove o usuário da fila quando ele for atendido ou a conversa encerrar.

function removeFromQueue(from) {
  const idx = handoverQueue.findIndex((x) => x.from === from);
  if (idx >= 0) handoverQueue.splice(idx, 1);
  inQueue.delete(from);

  broadcast("conversations", { at: nowISO() });
  broadcast("conversation", { waId: from, at: nowISO() });
}

//----------------------------------------------------------------------------- MENSAGEM DO EMAIL COM O CHAMADO ENVIADO AO RH---------------------------------------------------------------------------------

async function notifyRH({ from, position }) {/*Declara uma função assíncrona (porque ela usa await dentro).
Recebe um objeto com dois dados:
from = o número do usuário (ex.: "5511999999999"),
position = a posição dele na fila (1, 2, 3...).*/

  const subject = `BOT RH - Aguardando Atendimento (#${position}) - ${from}`; //Cria o assunto (subject) do e-mail.
  const fmtDate = new Date().toLocaleString("pt-BR", { hour12: false }); //Cria a data e hora atual no formato brasileiro
  const body = //Cria o corpo do e-mail (body)
`Olá, RH 👋

Há um novo contato aguardando atendimento humano no WhatsApp.

• Número: ${from}
• Posição na fila: #${position}
• Recebido em: ${fmtDate}

Sugestão: responder via WhatsApp Web
https://wa.me/${from.replace(/\D/g, "")}

Obs.: quando o atendimento for iniciado/concluído, o contato pode sair da fila automaticamente (ou quando o usuário retornar ao menu).`;

//Envio do email
  await mailer.sendMail({ //Envia o e-mail
    from: process.env.NOTIFY_FROM || process.env.SMTP_USER,//o remetente.Se existir NOTIFY_FROM no .env, usa ele.Caso contrário, usa SMTP_USER (o e-mail autenticado).
    to: process.env.NOTIFY_TO, //destinatário
    subject, //o título do e-mail (montado lá em cima).
    text: body, //o corpo do e-mail (sem HTML, só texto puro).
  });
}
//--------------------------------------------------------------------TRECHO RESPONSÁVEL POR RECEBER E RESPONDER AS MENSAGENS -----------------------------------------------------------------------

//Verificar conexão coma Meta

/*Esse endpoint é chamado uma única vez quando você conecta seu bot ao Meta Developers (WhatsApp Cloud API).
Ele serve apenas para confirmar que o servidor do seu bot está ativo e seguro.*/
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];//O Meta envia esse valor ("subscribe") pra indicar uma verificação.
  const token = req.query["hub.verify_token"];// É o token que você configurou no painel e também no seu código (VERIFY_TOKEN = "") (VERIFY_TOKEN).
  const challenge = req.query["hub.challenge"];//um número que o Meta gera e espera que você devolva para confirmar que seu servidor é válido.
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);/*Se o mode for "subscribe" e o token for igual ao que você definiu (VERIFY_TOKEN), então o bot responde com o challenge.
      Isso confirma a verificação e o Meta ativa o webhook.*/
  }
  return res.sendStatus(403);// Se algo estiver errado → retorna 403 Forbidden.
});

//Toda mensagem enviada por um usuário no WhatsApp é enviada pelo Meta ao seu servidor via POST.
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0];//é o caminho dentro do JSON que contém a mensagem real.
    const msg = change?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);//se não houver mensagem (por exemplo, é só confirmação de entrega), o bot ignora e responde 200 para o Meta (pra não gerar erro).

    const from = msg.from; //from é o número do usuário que enviou a mensagem (exemplo: "5511999999999").

    const text = msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ""; //Pega o conteúdo da mensagem, considerando vários tipos:
    const n = normalize(text); 
    try { logMessage(from, "user", text); } catch (e) {}
//deixa o texto sem espaços e em minúsculas para trabalhar com um padrão
    const stage = state.get(from) || "idle";

    /* CONTEXT RESCUE:
       Se por algum motivo o estado ficou desalinhado, mas o último menu enviado foi Ponto/Folha,
       e o usuário respondeu com um número válido, redireciona para o estado correto. */
    const ctx = lastMenuCtx.get(from);
    if (ctx && (Date.now() - (ctx.ts || 0)) < 5 * 60 * 1000) { // até 5 min
      if (ctx.menu === "ponto" && ["1","2","3","4","5","6","7","8"].includes(n) && stage === "await_main_choice") {
        state.set(from, "await_ponto_choice");
      }
      if (ctx.menu === "folha" && ["1","2","3","4","5"].includes(n) && stage === "await_main_choice") {
        state.set(from, "await_folha_choice");
      }
    } //Pega o estado atual da conversa desse número (guardado no Map state)

    // A cada nova mensagem recebida, o bot reinicia o temporizador de inatividade
    resetInactivityTimer(from);

  //------------------------------------------------------------------------------CONTROLE DE INICIO DE CONVERSA -----------------------------------------------------------------------


  /*Se o usuário é novo (idle) ou acabou de encerrar a conversa (ended), o bot:
    Manda a saudação + menu principal (sendWelcomeAndMenu(from));
    Atualiza o estado para "await_main_choice" (aguardando escolha do menu);
    Retorna 200 pro Meta pra confirmar que a mensagem foi processada.*/
    if (stage === "ended" || stage === "idle") {
      await sendWelcomeAndMenu(from);
      state.set(from, "await_main_choice");
      return res.sendStatus(200);
    }



  //------------------------------------------------------------------------------ COLETA DE NOME PARA ATENDIMENTO HUMANO -----------------------------------------------------------------------
    if (stage === "await_human_name") {
      const name = (text || "").toString().trim().replace(/\s+/g, " ");
      if (name.length < 2) {
        await sendText(from, "Pode me dizer seu nome, por favor? 🙂");
        return res.sendStatus(200);
      }
      userNames.set(from, name);

      const __pos = enqueueHandover(from);
    await sendText(from, handoverMsg(__pos));
      setState(from, "handover"); // agora está no humano
      stopInactivity(from); // não encerrar por inatividade durante handover

      try {
        const position = enqueueHandover(from);
        await notifyRH({ from, position });
      } catch (err) {
        console.error("Falha ao notificar RH:", err?.message || err);
      }

      return res.sendStatus(200);
    }

//------------------------------------------------------------------------------ TRATATIVA DAS OPÇÕES DO MENU PRINCIPAL   -----------------------------------------------------------------------

    if (stage === "await_main_choice") { //Só entra aqui se o estado atual do usuário for “aguardando escolha do menu principal”.
      if (["1", "2", "3", "4"].includes(n)) { //Garante que a resposta seja uma das opções válidas
        //Envia os Submenus
        if (n === "1") {
          await sendPontoMenu(from);
          state.set(from, "await_ponto_choice");
} else if (n === "2") {
          // entrar no submenu Folha & Benefícios
          lastMenuCtx.set(from, { menu: "folha", ts: Date.now() });
          await sendText(from, FOLHA_MENU);
          state.set(from, "await_folha_choice");
        } else if (n === "3") {
          // Dúvidas sobre holerite
          await sendText(from, "Escreva a sua dúvida e envie um print de seu holerite para que eu possa te direcionar ao atendimento humano");
          holeriteSessions.set(from, { hasText: false, hasImage: false, forwardTimer: null });
          state.set(from, "await_holerite_question");
        } else if (n === "4") {
          // ✅ Antes de encaminhar para humano, coletar nome (uma vez)
          const knownName = userNames.get(from);
          if (!knownName) {
            await sendText(from, "Antes de falar com um atendente, me diga seu *nome*, por favor 🙂");
            state.set(from, "await_human_name");
            return res.sendStatus(200);
          }


          const __pos = enqueueHandover(from);
    await sendText(from, handoverMsg(__pos));
          setState(from, "handover"); // agora está no humano
          stopInactivity(from); // não encerrar por inatividade durante handover

          try { // Coloca o usuário na fila de atendimento e manda um e-mail pro RH avisando
            const position = enqueueHandover(from);
            await notifyRH({ from, position });
          } catch (err) {
            console.error("Falha ao notificar RH:", err?.message || err);
            /*Se qualquer parte dentro do try der erro (por exemplo, problema de conexão SMTP, senha incorreta, fila corrompida etc.), o erro é capturado e exibido no console.*/
          }

          return res.sendStatus(200);//é o fechamento do endpoint /webhook, serve pra responder o WhatsApp (Meta) dizendo que o bot recebeu e processou a mensagem com sucesso.
        }

        /*esse trecho é o tratamento de respostas inválidas, ou seja, 
        o que o bot faz quando o usuário manda algo que não corresponde a nenhuma opção esperada.*/
      } else {
        await sendText(from, "Não consegui identificar sua resposta.");
        await wait(1000);
        await sendRootMenu(from);
        state.set(from, "await_main_choice");
      }
      return res.sendStatus(200);//é o fechamento do endpoint /webhook, serve pra responder o WhatsApp (Meta) dizendo que o bot recebeu e processou a mensagem com sucesso.
    }
//---------------------------------------------------------------------------------------INTERAÇÃO OPÇÃO 3 MENU (HOLERITE) -----------------------------------------------------------
    // Menu 3, dúvida sobre holerite (texto + imagem)
    if (stage === "await_holerite_question") { //pede para o usuário enviar um texto com a dúvida e uma imagem (print) do holerite;

    //Atualiza a sessão de holerite
      const sess = holeriteSessions.get(from) || { hasText: false, hasImage: false, forwardTimer: null };
      const hasText = !!(msg.text?.body);
      const hasImage = !!(msg.image);

      //Atualiza o progresso da sessão:
      if (hasText) sess.hasText = true;
      if (hasImage) sess.hasImage = true;
      holeriteSessions.set(from, sess);

      // Feedback mínimo para guiar o usuário
      if (!sess.hasText) {
        await sendText(from, "Recebi sua imagem. Agora, por favor, escreva a sua dúvida em texto.");
      } else if (!sess.hasImage) {
        await sendText(from, "Recebi sua mensagem. Agora, por favor, envie um print (imagem) do seu holerite.");
      }

      // Arma o temporizador
      if (sess.hasText && sess.hasImage) {
        armHoleriteForward(from);
      }

      // Não muda de estado ainda; handover será disparado pelo timer
      return res.sendStatus(200);
    }
  //------------------------------------------------------------------------------ TRATATIVA DAS OPÇÕES DO SUBMENU 1 PONTO   -----------------------------------------------------------------------

    if (stage === "await_ponto_choice") {
      // opções válidas: 1..8
      if (["1", "2", "3", "4", "5", "6", "7", "8"].includes(n)) {

        // 8 = retornar ao menu inicial
        if (n === "8") {
          removeFromQueue(from);
          await sendRootMenu(from);
          state.set(from, "await_main_choice");
          return res.sendStatus(200);
        }

        // 7 = falar com atendente (handover)
        if (n === "7") {
          const __name = (userNames.get(from) || "").toString().trim();
          if (!__name) {
            await sendText(from, "Antes de falar com um atendente, me diga seu nome, por favor 🙂");
            state.set(from, "await_human_name");
            return res.sendStatus(200);
          }

          const __pos = enqueueHandover(from);
          await sendText(from, handoverMsg(__pos));
          setState(from, "handover");
          stopInactivity(from);

          try {
            const position = enqueueHandover(from);
            await notifyRH({ from, position });
          } catch (err) {
            console.error("Falha ao notificar RH:", err?.message || err);
          }

          return res.sendStatus(200);
        }

        // 1..6 = passo a passo
        const map = {
          "1": PASSO_REGISTRAR,
          "2": PASSO_ESPELHO,
          "3": PASSO_ABONO,
          "4": PASSO_CANCELAR_BATIDA,
          "5": PASSO_INCLUIR,
          "6": PASSO_ATESTADO,
        };

        await sendText(from, map[n]);
        await wait(1000);
        await sendText(from, ASK_BACK);
        state.set(from, "await_back_menu");
        return res.sendStatus(200);

      } else {
        await sendText(from, "Não consegui identificar sua resposta.");
        await wait(1000);
        await sendPontoMenu(from);
        state.set(from, "await_ponto_choice");
        return res.sendStatus(200);
      }
    }

    //------------------------------------------------------------------------------ TRATATIVA DAS OPÇÕES DO SUBMENU 2 (FOLHA E BENEFÍCIOS)  -----------------------------------------------------------------------

    if (stage === "await_folha_choice") {
      if (["1", "2", "3", "4", "5"].includes(n)) { //Garante que a resposta seja uma das opções do submenu.
        if (n === "5") {
          // retornar ao menu inicial
          removeFromQueue(from); // garante limpeza do usuário na lista de chamados, se estava em fila
          await sendRootMenu(from); //Reenvia o menu principal e volta o estado para await_main_choice.
          state.set(from, "await_main_choice");
          return res.sendStatus(200);
        }
        if (n === "4") {
          const __name = (userNames.get(from) || "").toString().trim();
          if (!__name) {
            await sendText(from, "Antes de falar com um atendente, me diga seu nome, por favor 🙂");
            state.set(from, "await_human_name");
            return res.sendStatus(200);
          }

          // Muda oara o handover com looping natural
          const __pos = enqueueHandover(from);
    await sendText(from, handoverMsg(__pos));
          setState(from, "handover");
          stopInactivity(from); // não encerrar por inatividade durante handover


          try {// Coloca o usuário na fila de espera dos chamados e envia o email para o RH
            const position = enqueueHandover(from);
            await notifyRH({ from, position });
          } catch (err) {
            console.error("Falha ao notificar RH:", err?.message || err);
          }

          return res.sendStatus(200); // Não muda de estado ainda; handover será disparado pelo timer
        }
        /* Envia o conteúdo correspondente aos textos já prontos: atestado, histórico de pagamentos, etc.*/
        const map = {
          "1": PASSO_HIST_PAGAMENTOS,
          "2": PASSO_HIST_SALARIAL,
          "3": PASSO_INFORME,
        };

//------------------------------------------------------------------------------ RETORNA AO MENU INICIAL  -----------------------------------------------------------------------

        //Depois de 1s, pergunta “Deseja voltar ao Menu Inicial? 
        await sendText(from, map[n]);
        await wait(1000); // espera 1s
        await sendText(from, ASK_BACK);
        state.set(from, "await_back_menu");
      } else { // se o usuários da uma resposta inválida
        await sendText(from, "Não consegui identificar sua resposta.");
        await wait(1000);// espera 1s
        lastMenuCtx.set(from, { menu: "folha", ts: Date.now() });
          lastMenuCtx.set(from, { menu: "folha", ts: Date.now() });
        await sendText(from, FOLHA_MENU);//envia novamente o menu
        state.set(from, "await_folha_choice");
      }
      return res.sendStatus(200);
    }

    if (stage === "await_back_menu") {
      if (["sim", "s"].includes(n)) { // Se a resposta do usuário for sim
        removeFromQueue(from); //Remove ele da fila de chamados caso ele esteja
        await sendRootMenu(from);//Reenvia o menu inicial sem saldação
        state.set(from, "await_main_choice");

      } else if (["nao", "não", "n"].includes(n)) {// Se o usuário responde não
        await sendText(from, THANKS);// Envia mensagem de agradecimento e encerra o atendimento
        removeFromQueue(from); // Remove o usuário da fila de chamados pois o atendimento encerrou
        setState(from, "ended");// encerra o atendimento; próxima mensagem reinicia o bot com saudação+menu

      } else {//caso o usuário envie uma esposta errada
        await sendText(from, 'Não consegui identificar. Responda com "sim" ou "não".'); 
        await wait(1000); //espera 1s
        await sendText(from, ASK_BACK); //reenvia a mensagem de voltar ao menu
        state.set(from, "await_back_menu");
      }
      return res.sendStatus(200);
    }

//------------------------------------------------------------------------------ BOT EM ESTADO HANOVER (DORMINDO)  -----------------------------------------------------------------------

    // Se o usuário  manda mensagem estando no estado Hanover o bot oferece algumas opções de saída

    // Se o atendimento humano estiver ativo via painel (/admin), o bot não responde
    if (stage === "manual") {
      return res.sendStatus(200);
    }

    if (stage === "handover") {
      await sendText(from, ASK_HANDOVER); // envia  o menu com as duas opções
      state.set(from, "await_handover_choice"); // entra em estado de espera da resposta com a escolha
      return res.sendStatus(200);
    }

    // se o bot está em estado de espera, aguardando a escolha
    if (stage === "await_handover_choice") {
      if (n === "1") { //e se a resposta do usuário for 1
        removeFromQueue(from); // Ele remove o usuário da fila de chamados 
        //retoma o fluxo do bot 
        await sendRootMenu(from);
        state.set(from, "await_main_choice");
        return res.sendStatus(200);

      } else if (n === "2") {//e se a resposta do usuário for 1
        // o Bot reenvia a mensagem de encaminhameneto 
        const __pos = enqueueHandover(from);
    await sendText(from, handoverMsg(__pos));
        setState(from, "handover");// e retorna para o estado "Dormindo"
        stopInactivity(from); // mantém regra de não encerrar por inatividade no handover

        // Garante o a posição do usuário na fila e garante que o RH foi avisado 
        try {
          const position = enqueueHandover(from);
          await notifyRH({ from, position });
        } catch (err) {
          console.error("Falha ao notificar RH:", err?.message || err);
        }

        return res.sendStatus(200);
      } else { // Itentific uma resposta inválida e reenvia a pergunta
        await sendText(from, "Não consegui identificar sua resposta. Por favor, escolha uma das opções.");
        await sendText(from, ASK_HANDOVER);
        return res.sendStatus(200);
      }
    }

    // verificação de segurança, volta para o menu principal (sem saudação)
    removeFromQueue(from); // Limpa qualquer resíduo na fila de chamados
    await sendRootMenu(from);
    state.set(from, "await_main_choice");
    return res.sendStatus(200);
  } catch (e) {
    console.error("Erro no webhook:", e?.response?.data || e.message);
    return res.sendStatus(200);
  }
});

//------------------------------------------------------------------------------ TESTE DE VERIFICAÇÃO DE CONEXÃO COM O EMAIL  -----------------------------------------------------------------------


//------------------------------------------------------------------------------ TESTE DE ENVIO DE MENSAGEM (TEMPLATE)  -----------------------------------------------------------------------
// Use este endpoint para FAZER A PRIMEIRA MENSAGEM chegar no seu número de teste (inicia a conversa via template).
// Você pode passar ?to=5511999999999 (somente números) para testar outro destino autorizado.
app.get("/test-message", async (req, res) => {
  const raw = (req.query.to || process.env.TEST_NUMBER).toString();
  const to = raw.replace(/\D/g, ""); // deixa só dígitos (DDI+DDD+NÚMERO)
  try {
    console.log("Enviando TEMPLATE hello_world para:", to);
    const r = await sendHelloWorldTemplate(to);
    console.log("✅ WhatsApp API response:", r.data);
    return res.status(200).send("✅ Mensagem TEMPLATE (hello_world) enviada. Verifique o WhatsApp e os logs.");
  } catch (e) {
    console.error("❌ Erro ao enviar TEMPLATE:", e?.response?.data || e.message);
    return res.status(500).send("❌ Falha ao enviar TEMPLATE. Veja logs do Koyeb.");
  }
});

app.get("/test-email", async (req, res) => { //Cria uma rota GET /test-email para disparar um envio de teste via Nodemailer.
  try {
    const info = await mailer.sendMail({//Usa o transporter mailer JA CRIADO para enviar e-mail.
      from: `BOT RH (Demo) <${process.env.SMTP_USER}>`,//mostra “BOT RH (Demo)” com o remetente do .env
      to: process.env.NOTIFY_TO || process.env.SMTP_USER, //manda para NOTIFY_TO se existir; senão, vai para o próprio SMTP_USER.
      //Mensagem
      subject: "Teste de envio (Nodemailer)",
      text: "Olá! Este é um teste de envio via Nodemailer.",
      html: "<p>Olá! Este é um <b>teste</b> de envio via Nodemailer.</p>",
    });
    return res.status(200).send(`✅ Email enviado! MessageId: ${info.messageId || "(n/a)"}`); //Se deu certo, retorna 200 com o messageId.
  } catch (err) {//Se der erro, cai no catch.
    console.error("Falha ao enviar email:", err);
    return res.status(500).send(`❌ Erro ao enviar: ${err?.response || err?.message || err}`);
  }
});

//------------------------------------------------------------------------------ FINALIZA O CICLO PRINCIPAL DO BOT  -----------------------------------------------------------------------

app.get("/", (req, res) => res.send("Servidor do Bot RH ativo!"));//rota raiz: confirma que o servidor está ativo

app.get("/healthz", (req, res) => res.status(200).send("ok"));// rota de healthcheck (para serviços de hospedagem monitorarem)




// ====================================================================================== PAINEL ADMIN (/admin) ============================================================================

/*função que recebe o numero de telefone e deixa ele com uma estrutura visual melhor
recebe o numero cru (5511987654321) e devolve corrigido (+55 11 98765-4321)*/

function toDisplayPhone(waId) {
  const s = (waId || "").toString().trim();
  if (s.startsWith("55") && s.length >= 12) {
    const ddd = s.slice(2,4);
    const num = s.slice(4);
    if (num.length === 9) return `+55 ${ddd} ${num.slice(0,5)}-${num.slice(5)}`;
    if (num.length === 8) return `+55 ${ddd} ${num.slice(0,4)}-${num.slice(4)}`;
    return `+55 ${ddd} ${num}`;
  }
  return s ? `+${s}` : "";
}

//o painel é “uma página de site” dentro do código
function adminHTML() {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WhatsApp RH Bot (Demo) — Admin</title>
<style>
:root{--bg:#0b141a;--panel:#111b21;--panel2:#202c33;--text:#e9edef;--muted:#aebac1;--accent:#00a884;--danger:#ef4444;--warn:#f59e0b;--border:rgba(233,237,239,.10);}
*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial;}
body{margin:0;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;}
header{padding:12px 16px;background:var(--panel);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;}
.small{color:var(--muted);font-size:12px;}
.wrap{flex:1;display:grid;grid-template-columns:340px 1fr;min-height:0;}
.sidebar{background:var(--panel);border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0;}
.search{padding:12px;border-bottom:1px solid var(--border);}
.search input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--panel2);color:var(--text);outline:none;}
.list{flex:1;overflow:auto;}
.item{padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;}
.item:hover{background:rgba(255,255,255,.03);}
.item.active{background:rgba(0,168,132,.10);}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;}
.name{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;}
.meta{color:var(--muted);font-size:12px;white-space:nowrap;}
.pill{font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--border);color:var(--muted);}
.pill.green{color:var(--accent);border-color:rgba(0,168,132,.35);background:rgba(0,168,132,.08);}
.pill.yellow{color:var(--warn);border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.08);}
.unread{min-width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--accent);color:#062f27;font-weight:800;font-size:12px;padding:0 7px;}
main{display:flex;flex-direction:column;min-height:0;}
.chatHeader{padding:12px 16px;background:var(--panel);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;}
.actions{display:flex;gap:8px;flex-wrap:wrap;}
button{padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--panel2);color:var(--text);cursor:pointer;}
button.primary{background:rgba(0,168,132,.12);border-color:rgba(0,168,132,.35);}
button.danger{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35);}
.messages{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:10px;}
.bubble{max-width:min(720px,78%);padding:10px 12px;border-radius:16px;white-space:pre-wrap;word-break:break-word;border:1px solid rgba(255,255,255,.06);}
.in{align-self:flex-start;background:#202c33;}
.out{align-self:flex-end;background:#005c4b;}
.human{align-self:flex-end;background:#1f2937;border-color:rgba(255,255,255,.10);}
.ts{display:block;margin-top:6px;font-size:11px;color:rgba(233,237,239,.65);}
.composer{padding:12px 14px;border-top:1px solid var(--border);display:flex;gap:10px;background:var(--panel);}
.composer textarea{flex:1;resize:none;min-height:42px;max-height:140px;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--panel2);color:var(--text);outline:none;}
.empty{padding:24px;color:var(--muted);}
.tabs{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);} .tab{flex:1;background:transparent;border:1px solid var(--border);color:var(--muted);padding:8px 10px;border-radius:10px;cursor:pointer;font-size:12px;} .tab.active{border-color:rgba(0,168,132,.35);color:var(--text);background:rgba(0,168,132,.08);} 
</style>
</head>
<body>
<header>
  <div>
    <div style="font-weight:800;">WhatsApp RH Bot (Demo) — Admin</div>
    <div class="small" id="conn">Conectando…</div>
  </div>
  <div class="small">Atualização em tempo real</div>
</header>

<div class="wrap">
  <aside class="sidebar">
    <div class="search"><input id="q" placeholder="Buscar por nome ou número…"/></div>
    <div class="tabs" id="tabs">
      <button class="tab active" data-tab="queue">Na fila</button>
      <button class="tab" data-tab="manual">Em atendimento</button>
      <button class="tab" data-tab="ended">Encerrados</button>
    </div>
    <div class="list" id="list"></div>
  </aside>

  <main>
    <div class="chatHeader">
      <div style="min-width:0;">
        <div style="font-weight:800;" id="contactName">Selecione uma conversa</div>
        <div class="small" id="contactSub"></div>
      </div>
      <div class="actions" id="actions" style="display:none;">
        <button class="primary" id="btnAssume">Entrar no atendimento</button>
        <button class="danger" id="btnEnd">Encerrar atendimento</button>
</div>
    </div>

    <div class="messages" id="messages"><div class="empty">Abra uma conversa à esquerda.</div></div>

    <div class="composer" id="composer" style="display:none;">
      <textarea id="text" placeholder="Mensagem do atendente…"></textarea>
      <button class="primary" id="btnSend">Enviar</button>
    </div>
  </main>
</div>

<script>
const $=(id)=>document.getElementById(id);
let allConvos=[]; let activeId=null; let activeData=null;

function fmtTS(iso){ try{ return new Date(iso).toLocaleString('pt-BR'); }catch(e){ return ''; } }
function displayName(c){
  const phone=c.displayPhone||('+'+(c.waId||'')); const nm=(c.name||'').trim();
  return nm ? (nm+' — '+phone) : phone;
}
function statusOf(c){
  if(c.state==='ended') return {label:'Encerrado', cls:'gray'};
  if(c.state==='manual') return {label:'Em atendimento', cls:'green'};
  if(c.inQueue || c.state==='handover') {
    const pos = Number(c.queuePos||0);
    return {label:('Na fila ' + (pos?('#'+pos):'')).trim(), cls:'yellow'};
  }
  return {label:'Bot ativo', cls:''};
}

function renderList(){
  const q=($('q').value||'').toLowerCase().trim();
  const currentTab=(window.__currentTab||'queue');
  const filtered=allConvos.filter(c=>{
    // Pastinhas/abas: Na fila | Em atendimento | Encerrados
    if(currentTab==='queue'){
      if(!(c.inQueue || c.state==='handover')) return false;
    } else if(currentTab==='manual'){
      if(c.state!=='manual') return false;
    } else if(currentTab==='ended'){
      if(c.state!=='ended') return false;
    }
    if(!q) return true;
    return String(c.name||'').toLowerCase().includes(q) || String(c.displayPhone||'').toLowerCase().includes(q) || String(c.waId||'').includes(q);
  }).sort((a,b)=> String(b.lastMessageAt||'').localeCompare(String(a.lastMessageAt||'')));
  const list=$('list'); list.innerHTML='';
  if(!filtered.length){ list.innerHTML='<div class="empty">Sem conversas.</div>'; return; }
  for(const c of filtered){
    const st=statusOf(c);
    const unread=Number(c.unread||0);
    const div=document.createElement('div');
    div.className='item'+(c.waId===activeId?' active':'');
    div.innerHTML=\`
      <div class="row">
        <div class="name" title="\${displayName(c)}">\${displayName(c)}</div>
        \${unread>0?'<span class="unread">'+unread+'</span>':''}
      </div>
      <div class="row" style="margin-top:6px;">
        <div class="meta">\${c.lastUserMessageAt?('Última do usuário: '+fmtTS(c.lastUserMessageAt)):(c.lastMessageAt?('Última: '+fmtTS(c.lastMessageAt)):'')}</div>
        <span class="pill \${st.cls}">\${st.label}</span>
      </div>\`;
    div.onclick=()=>openConversation(c.waId);
    list.appendChild(div);
  }
}

async function fetchConversations(){
  const r=await fetch('/admin/api/conversations');
  const data=await r.json();
  allConvos=data.conversations||[];
  renderList();
}
async function fetchConversation(waId){
  const r=await fetch('/admin/api/conversation/'+encodeURIComponent(waId));
  const data=await r.json();
  return data.conversation;
}
function scrollBottom(){ const el=$('messages'); el.scrollTop=el.scrollHeight; }

function renderConversation(conv){
  activeData=conv;
  $('messages').innerHTML='';
  $('contactName').textContent=displayName(conv);
  $('contactSub').textContent='WaId: '+conv.waId+' • Estado: '+(conv.state||'idle');
  $('actions').style.display='flex';
  $('composer').style.display='flex';

  // ✅ botões
  const st=statusOf(conv);
  $('btnAssume').style.display = (conv.state==='manual') ? 'none' : (st.label==='Na fila' ? 'inline-flex' : 'none');
  $('btnEnd').style.display = (conv.state==='manual') ? 'inline-flex' : 'none';

  for(const m of (conv.messages||[])){
    const b=document.createElement('div');
    const cls = (m.from==='user')?'in':(m.from==='human'?'human':'out');
    b.className='bubble '+cls;
    b.innerHTML=(m.text||'').replace(/</g,'&lt;') + '<span class="ts">'+(m.from==='user'?'Usuário':(m.from==='human'?'Humano':'Bot'))+' • '+fmtTS(m.ts)+'</span>';
    $('messages').appendChild(b);
  }
  // auto-scroll only if user is near bottom
const el = document.getElementById('messages');
if (el) {
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}
  markRead(conv.waId,true).catch(()=>{});
}

async function openConversation(waId){
  activeId=waId;
  const conv=await fetchConversation(waId);
  renderConversation(conv);
  renderList();
}

async function sendMessage(){
  const t=$('text').value.trim();
  if(!t || !activeId) return;
  $('text').value='';
  await fetch('/admin/api/conversation/'+encodeURIComponent(activeId)+'/message', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})});
}
async function assume(){ if(!activeId) return; await fetch('/admin/api/conversation/'+encodeURIComponent(activeId)+'/assume',{method:'POST'}); }
async function end(){ if(!activeId) return; await fetch('/admin/api/conversation/'+encodeURIComponent(activeId)+'/end',{method:'POST'}); }
async function markRead(waId,silent){ if(!waId) return; await fetch('/admin/api/conversation/'+encodeURIComponent(waId)+'/mark-read',{method:'POST'}); if(!silent) await fetchConversations(); }

$('btnSend').onclick=sendMessage;
$('btnAssume').onclick=assume;
$('btnEnd').onclick=end;
const _textEl = $('text'); if (_textEl) _textEl.addEventListener('keydown',(e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(); }});
const _qEl = $('q'); if (_qEl) _qEl.addEventListener('input', ()=>renderList());
const _tabs = $('tabs');
if(_tabs){
  window.__currentTab = window.__currentTab || 'queue';
  _tabs.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      _tabs.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      window.__currentTab = btn.dataset.tab;
      renderList();
    });
  });
}

const es=new EventSource('/admin/events');
es.onopen=()=> $('conn').textContent='Online';
es.onerror=()=> $('conn').textContent='Reconectando…';
es.addEventListener('conversations', ()=>fetchConversations().catch(()=>{}));
es.addEventListener('conversation', async (ev)=>{
  try{
    const p=JSON.parse(ev.data||'{}');
    if(activeId && p.waId===activeId){
      const conv=await fetchConversation(activeId);
      renderConversation(conv);
    }else{
      await fetchConversations();
    }
  }catch(e){}
});

fetchConversations().catch(()=>{});
</script>
</body></html>`;
}

//exibe a pagina quando alguem abre
app.get("/admin", (req, res) => res.status(200).send(adminHTML()));

//mantem o bot ao vivo
app.get("/admin/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const id = String(sseSeq++);
  sseClients.set(id, res);
  try { sseSend(res, "hello", { ok: true, at: nowISO() }); } catch (e) {}

  req.on("close", () => { sseClients.delete(id); });
});

//Essa rota devolve a lista de conversas pro painel:
app.get("/admin/api/conversations", (req, res) => {
  const conversations = [];
  for (const [waId, convo] of convoStore.entries()) {
    const name = userNames.get(waId) || "";
    conversations.push({
      waId,
      name,
      displayPhone: toDisplayPhone(waId),
      state: state.get(waId) || "idle",
      inQueue: inQueue.has(waId),
      queuePos: inQueue.has(waId) ? (handoverQueue.findIndex((x)=>x.from===waId)+1) : 0,
      unread: convo.unread || 0,
      lastMessageAt: convo.lastMessageAt,
      lastUserMessageAt: convo.lastUserMessageAt,
    });
  }
  res.json({ conversations });
});

//Essa rota devolve uma conversa específica (pra abrir no chat).
app.get("/admin/api/conversation/:waId", (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  const convo = getConvo(waId);
  const name = userNames.get(waId) || "";
  res.json({
    conversation: {
      waId,
      name,
      displayPhone: toDisplayPhone(waId),
      state: state.get(waId) || "idle",
      inQueue: inQueue.has(waId),
      queuePos: inQueue.has(waId) ? (handoverQueue.findIndex((x)=>x.from===waId)+1) : 0,
      unread: convo.unread || 0,
      lastMessageAt: convo.lastMessageAt,
      lastUserMessageAt: convo.lastUserMessageAt,
      messages: (convo.messages || []).slice(-500),
    }
  });
});

app.post("/admin/api/conversation/:waId/mark-read", (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  markRead(waId);
  res.json({ ok: true });
});

app.post("/admin/api/conversation/:waId/assume", async (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  removeFromQueue(waId);
  setState(waId, "manual");
  stopInactivity(waId);
  markRead(waId);
  const nm = userNames.get(waId);
  await sendHumanText(waId, `✅ Atendimento iniciado${nm ? `, ${nm}` : ""}. Pode me explicar sua dúvida?`);
  res.json({ ok: true });
});

app.post("/admin/api/conversation/:waId/end", async (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  removeFromQueue(waId);
  setState(waId, "ended");
  markRead(waId);
  await sendHumanText(waId, THANKS);
  res.json({ ok: true });
});

app.post("/admin/api/conversation/:waId/message", async (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  const text = (req.body?.text || "").toString().trim();
  if (!text) return res.status(400).json({ error: "empty_text" });

  if ((state.get(waId) || "") !== "manual") {
    removeFromQueue(waId);
    setState(waId, "manual");
    stopInactivity(waId);
  }

  //Zera não lidas do usuário.
  markRead(waId);
  await sendHumanText(waId, text);
  res.json({ ok: true });
});

// =========================================================================================== FIM PAINEL ADMIN ==========================================================================

app.listen(PORT, () => { //inicialização do boot no servidor

  //Confirma visualmente no terminal que o servidor iniciou corretamente.
  console.log(`Servidor rodando na porta ${PORT}`);
  // Mostra apenas o tamanho do token, e não o valor real — boa prática de segurança.Serve para garantir que a variável de ambiente foi lida (e não está vazia)
  console.log("DEBUG TOKEN len:", (process.env.WHATSAPP_TOKEN || "").length);
  //Mostra o ID do número de WhatsApp que está configurado — útil para checar se está certo antes de testar a API.
  if (process.env.DEBUG === "1") console.log("DEBUG PHONE_NUMBER_ID:", process.env.PHONE_NUMBER_ID);

  // Verificação básica das variáveis de ambiente
  if (!process.env.WHATSAPP_TOKEN) {
    console.warn("⚠️  Atenção: variável WHATSAPP_TOKEN não encontrada no .env!");
  }
  if (!process.env.PHONE_NUMBER_ID) {
    console.warn("⚠️  Atenção: variável PHONE_NUMBER_ID não encontrada no .env!");
  }
  if (!process.env.SMTP_USER) {
    console.warn("⚠️  Atenção: variável SMTP_USER não encontrada no .env!");
  }
});

// ===============================================================================Tratamentos globais de erro =====================================================================
process.on("unhandledRejection", (err) => {
  console.error("🚨 Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("🚨 Uncaught Exception:", err);
});
