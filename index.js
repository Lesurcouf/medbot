import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!BOT_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("❌ Укажите BOT_TOKEN и ANTHROPIC_API_KEY в переменных окружения");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// История сообщений на пользователя (in-memory)
const userHistory = new Map();
const userSpecialty = new Map();

// Статистика
const ADMIN_ID = 489560133;
const statsRequests = new Map(); // date -> count
const statsUsers = new Map();    // date -> Set of userIds
const pendingFullAnswer = new Map(); // chatId -> { question, specialty }

// Стикеры для ожидания ответа
const STICKERS = [
  "CAACAgIAAxkBAAFD9Uhpqewy1sP9U0XeUyuvs1LPm8s_bgACoi8AAjXDiElhaH29-3ofGzoE",
  "CAACAgIAAxkBAAFD9Vdpqey2X407TT5lT0Ma-KZM6T9oDQACVTUAAi6SqEl3Mu_lOYXBGzoE",
  "CAACAgIAAxkBAAFD9Vlpqezaf6ZKSCbRodhewpLzNCJg7wACKD0AAk8BsUsHT7-36-gCxToE",
  "CAACAgIAAxkBAAFD9WFpqez_uchgXhdsy6k94V1HhvId9AACXXgAAojD8Uhh82UePK7UIToE",
];

const SYSTEM_PROMPT = `Ты — медицинский ассистент-бот для студентов медицинских вузов России.
Твоя специализация — клинические рекомендации Министерства здравоохранения РФ с сайта cr.minzdrav.gov.ru.

Охватываемые специальности: терапия, кардиология, пульмонология, хирургия, травматология, педиатрия, неврология, эндокринология, урология, гинекология, онкология, гастроэнтерология, нефрология, ревматология, инфекционные болезни, дерматология, психиатрия, офтальмология, оториноларингология и все прочие специальности.

Формат ответов:
- Структурируй по разделам: Определение → Классификация → Диагностика → Лечение → Ключевые моменты
- Всегда указывай источник: название КР, год утверждения, МКБ-10 код
- Выделяй уровни доказательности (УД А/В/С) и силу рекомендаций (СР 1/2/3) когда важно
- Если студент присылает медицинскую задачу или тест — разбери её по шагам: анализ условия, диагноз, обоснование, правильный ответ со ссылкой на КР
- НЕ используй markdown: никаких решёток, звёздочек, подчёркиваний — только обычный текст
- СТРОГО ЗАПРЕЩЕНО: горизонтальные линии из символов -, =, —, _, любые разделители
- СТРОГО ЗАПРЕЩЕНО: таблицы с символом | — вместо таблиц используй нумерованные списки
- СТРОГО ЗАПРЕЩЕНО: одиночное тире — на отдельной строке
- Для заголовков разделов используй КАПСЛОК или эмодзи, например: 🔍 ДИАГНОСТИКА, 💊 ЛЕЧЕНИЕ
- Для списков используй • или цифры с точкой
- Для неотложных состояний добавляй предупреждение о необходимости врача
- Отвечай только на русском языке
- По умолчанию давай КРАТКИЙ ответ: только суть, ключевые критерии и главное по лечению — не более 300-400 слов
- Если в запросе есть слово РАЗВЕРНУТО или ПОДРОБНО — давай полный детальный ответ без ограничений`;

const SPECIALTIES = [
  { name: "🫀 Кардиология", cb: "cardio" },
  { name: "🫁 Пульмонология", cb: "pulmo" },
  { name: "🩺 Терапия", cb: "therapy" },
  { name: "🔪 Хирургия", cb: "surgery" },
  { name: "👶 Педиатрия", cb: "pediatry" },
  { name: "🧠 Неврология", cb: "neuro" },
  { name: "🍬 Эндокринология", cb: "endo" },
  { name: "🫘 Урология", cb: "urology" },
  { name: "👩 Гинекология", cb: "gyneco" },
  { name: "🦠 Инфекционные", cb: "infect" },
  { name: "🩻 Ревматология", cb: "reumato" },
  { name: "🔬 Онкология", cb: "onco" },
  { name: "❓ Другая специальность", cb: "other" },
];

const SPECIALTY_PROMPTS = {
  cardio: "Кардиология",
  pulmo: "Пульмонология",
  therapy: "Терапия",
  surgery: "Хирургия",
  pediatry: "Педиатрия",
  neuro: "Неврология",
  endo: "Эндокринология",
  urology: "Урология",
  gyneco: "Гинекология",
  infect: "Инфекционные болезни",
  reumato: "Ревматология",
  onco: "Онкология",
  other: null,
};

function getMainMenuKeyboard() {
  // Разбиваем на ряды по 2 кнопки
  const rows = [];
  for (let i = 0; i < SPECIALTIES.length - 1; i += 2) {
    rows.push([
      { text: SPECIALTIES[i].name, callback_data: SPECIALTIES[i].cb },
      { text: SPECIALTIES[i + 1].name, callback_data: SPECIALTIES[i + 1].cb },
    ]);
  }
  // Последняя кнопка "Другая" на всю ширину
  rows.push([{ text: SPECIALTIES[SPECIALTIES.length - 1].name, callback_data: "other" }]);
  return { inline_keyboard: rows };
}

function getBackKeyboard(withExpand = false) {
  const rows = [];
  if (withExpand) {
    rows.push([{ text: "📖 Дать развёрнутый ответ", callback_data: "expand_answer" }]);
  }
  rows.push([{ text: "← Главное меню", callback_data: "main_menu" }]);
  return { inline_keyboard: rows };
}

// /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userHistory.delete(chatId);
  userSpecialty.delete(chatId);

  bot.sendMessage(
    chatId,
    `Привет. Я КлиникБаза — медицинский ассистент на основе клинических рекомендаций МЗ РФ.\n\n` +
    `Могу помочь:\n` +
    `• Найти клинические рекомендации\n` +
    `• Подготовиться к экзаменам\n` +
    `• Решить клинические задачи и тесты\n` +
    `• Объяснить критерии диагностики и схемы лечения\n` +
    `• Расшифровать исследования и интерпретировать анализы\n\n` +
    `Выберите специальность:`,
    {  reply_markup: getMainMenuKeyboard() }
  );
});

// /menu
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  userSpecialty.delete(chatId);
  bot.sendMessage(chatId, "🏥 *Главное меню* — выберите специальность:", {
    
    reply_markup: getMainMenuKeyboard(),
  });
});

// /getsticker — получить file_id стикера (только для админа)
bot.on("sticker", (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;
  const id = msg.sticker.file_id;
  bot.sendMessage(ADMIN_ID, `file_id стикера:\n\n${id}`);
});

// /stats — только для админа
bot.onText(/\/stats/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;
  const today = new Date().toISOString().slice(0, 10);
  const requests = statsRequests.get(today) || 0;
  const users = statsUsers.has(today) ? statsUsers.get(today).size : 0;
  let total = 0;
  for (const v of statsRequests.values()) total += v;
  bot.sendMessage(ADMIN_ID,
    `📊 Статистика\n\nСегодня (${today}):\n• Запросов: ${requests}\n• Уникальных пользователей: ${users}\n\nВсего запросов за сессию: ${total}`
  );
});

// Callback кнопок
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  bot.answerCallbackQuery(query.id);

  if (data === "expand_answer") {
    const pending = pendingFullAnswer.get(chatId);
    if (!pending) {
      bot.answerCallbackQuery(query.id, { text: "Вопрос не найден, задайте его заново" });
      return;
    }
    const expandSticker = STICKERS[Math.floor(Math.random() * STICKERS.length)];
    const expandStickerMsg = await bot.sendSticker(chatId, expandSticker);
    bot.sendChatAction(chatId, "typing");
    const expandPrompt = pending.specialty
      ? SYSTEM_PROMPT + `\n\nСтудент выбрал специальность: ${pending.specialty}.`
      : SYSTEM_PROMPT;
    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8192,
        system: expandPrompt + "\n\nДай РАЗВЁРНУТЫЙ но КОМПАКТНЫЙ ответ. Охвати ключевые аспекты: определение, классификацию, диагностику, лечение, уровни доказательности, источники КР. Избегай воды и повторений — только суть. СТРОГО ЗАПРЕЩЕНО использовать линии из символов = или - для разделения разделов. Только текст и эмодзи. Уложись в разумный объём.",
        messages: [{ role: "user", content: "РАЗВЕРНУТО: " + pending.question }],
      });
      let fullText = response.content.filter(b => b.type === "text").map(b => b.text).join("");
      fullText = cleanMarkdown(fullText);
      try { await bot.deleteMessage(chatId, expandStickerMsg.message_id); } catch(e) {}
      const chunks = splitMessage(fullText);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        await bot.sendMessage(chatId, chunks[i], {
          reply_markup: isLast ? getBackKeyboard() : undefined,
        });
      }
    } catch (e) {
      bot.sendMessage(chatId, "⚠️ Ошибка. Попробуйте ещё раз.", { reply_markup: getBackKeyboard() });
    }
    return;
  }

  if (data === "main_menu") {
    userSpecialty.delete(chatId);
    userHistory.delete(chatId);
    bot.sendMessage(chatId, "🏥 *Главное меню* — выберите специальность:", {
      
      reply_markup: getMainMenuKeyboard(),
    });
    return;
  }

  const specialtyName = SPECIALTY_PROMPTS[data];

  if (data === "other") {
    userSpecialty.set(chatId, null);
    bot.sendMessage(chatId, "❓ Готов ответить на ваш вопрос!\n\nЧто вас интересует?", {
      reply_markup: getBackKeyboard(),
    });
  } else if (specialtyName) {
    userSpecialty.set(chatId, specialtyName);
    const spec = SPECIALTIES.find((s) => s.cb === data);
    bot.sendMessage(
      chatId,
      `${spec.name}\n\nГотов ответить на любой вопрос по этой специальности:\n• Диагностические критерии и классификации\n• Схемы лечения и препараты по КР МЗ РФ\n• Уровни доказательности\n• Разбор клинических случаев\n\n*Что вас интересует?*`,
      {  reply_markup: getBackKeyboard() }
    );
  }
});

// Вспомогательная функция — скачать файл из Telegram и вернуть base64
async function downloadFileAsBase64(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
  const res = await fetch(fileUrl);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

// Входящие сообщения
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Пропускаем команды
  if (text && text.startsWith("/")) return;

  // Пропускаем если нет ни текста, ни фото, ни документа
  if (!text && !msg.photo && !msg.document) return;

  // Инициализируем историю
  if (!userHistory.has(chatId)) userHistory.set(chatId, []);
  const history = userHistory.get(chatId);

  const specialty = userSpecialty.get(chatId);
  const systemPrompt = SYSTEM_PROMPT +
    (specialty ? `\n\nСтудент выбрал специальность: ${specialty}. Фокусируйся на вопросах по этой специальности.` : "");

  // Отправляем случайный стикер пока думаем
  const randomSticker = STICKERS[Math.floor(Math.random() * STICKERS.length)];
  const stickerMsg = await bot.sendSticker(chatId, randomSticker);
  bot.sendChatAction(chatId, "typing");

  // Формируем контент сообщения для Claude
  let userContent = [];

  // Обработка фото
  if (msg.photo) {
    try {
      const photo = msg.photo[msg.photo.length - 1]; // берём максимальное разрешение
      const base64 = await downloadFileAsBase64(photo.file_id);
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: base64 },
      });
      const caption = msg.caption || "Проанализируй это медицинское изображение. Опиши что видишь и дай клиническую интерпретацию согласно КР МЗ РФ.";
      userContent.push({ type: "text", text: caption });
    } catch (e) {
      bot.sendMessage(chatId, "Не удалось загрузить фото. Попробуйте ещё раз.", { reply_markup: getBackKeyboard() });
      return;
    }
  }
  // Обработка документа (PDF)
  else if (msg.document) {
    const doc = msg.document;
    const isPdf = doc.mime_type === "application/pdf";
    const isImage = doc.mime_type && doc.mime_type.startsWith("image/");

    if (isPdf) {
      try {
        const base64 = await downloadFileAsBase64(doc.file_id);
        userContent.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        });
        const caption = msg.caption || "Прочитай этот документ и кратко изложи ключевую медицинскую информацию.";
        userContent.push({ type: "text", text: caption });
      } catch (e) {
        bot.sendMessage(chatId, "Не удалось загрузить PDF. Убедитесь что файл не превышает 20 МБ.", { reply_markup: getBackKeyboard() });
        return;
      }
    } else if (isImage) {
      try {
        const base64 = await downloadFileAsBase64(doc.file_id);
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: doc.mime_type, data: base64 },
        });
        const caption = msg.caption || "Проанализируй это медицинское изображение.";
        userContent.push({ type: "text", text: caption });
      } catch (e) {
        bot.sendMessage(chatId, "Не удалось загрузить изображение.", { reply_markup: getBackKeyboard() });
        return;
      }
    } else {
      bot.sendMessage(chatId, "Поддерживаются только фото и PDF файлы.", { reply_markup: getBackKeyboard() });
      return;
    }
  }
  // Обычный текст
  else {
    userContent = text;
  }

  // Считаем статистику
  const today = new Date().toISOString().slice(0, 10);
  statsRequests.set(today, (statsRequests.get(today) || 0) + 1);
  if (!statsUsers.has(today)) statsUsers.set(today, new Set());
  statsUsers.get(today).add(chatId);

  history.push({ role: "user", content: userContent });

  // Ограничиваем историю последними 10 сообщениями
  if (history.length > 10) history.splice(0, history.length - 10);

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      system: systemPrompt,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: history,
    });

    // Извлекаем текст из ответа
    let replyText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Если был tool_use — делаем второй запрос
    if (response.stop_reason === "tool_use") {
      bot.sendChatAction(chatId, "typing");
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const toolResults = toolUseBlocks.map((tool) => ({
        type: "tool_result",
        tool_use_id: tool.id,
        content: "Поиск выполнен по базе клинических рекомендаций cr.minzdrav.gov.ru",
      }));

      const followUp = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8192,
        system: systemPrompt,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [...history, { role: "assistant", content: response.content }, { role: "user", content: toolResults }],
      });

      replyText = followUp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    }

    // Добавляем ответ в историю
    history.push({ role: "assistant", content: replyText });

    // Очищаем markdown — убираем решётки и звёздочки
    replyText = cleanMarkdown(replyText);

    // Удаляем стикер
    try { await bot.deleteMessage(chatId, stickerMsg.message_id); } catch(e) {}

    // Сохраняем вопрос для возможного развёрнутого ответа
    const lastUserMsg = history[history.length - 2];
    const lastQuestion = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : null;
    if (lastQuestion) {
      pendingFullAnswer.set(chatId, { question: lastQuestion, specialty: userSpecialty.get(chatId) });
    }

    // Telegram ограничение — разбиваем если нужно
    const chunks = splitMessage(replyText);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await bot.sendMessage(chatId, chunks[i], {
        reply_markup: isLast ? getBackKeyboard(!!lastQuestion) : undefined,
      });
    }
  } catch (err) {
    console.error("Ошибка API:", err);
    bot.sendMessage(chatId, "⚠️ Произошла ошибка. Попробуйте ещё раз.", {
      reply_markup: getBackKeyboard(),
    });
  }
});

// Очистка markdown символов
function cleanMarkdown(text) {
  return text
    .replace(/#{1,6} /g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/[=\-]{2,}/g, "")
    .replace(/^\s*[—–]\s*$/gm, "")
    .replace(/^\s*—\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Разбивка длинных сообщений
function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

console.log("🤖 МедАссистент КР запущен!");
