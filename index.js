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

const SYSTEM_PROMPT = `Ты — медицинский ассистент-бот для студентов медицинских вузов России.
Твоя специализация — клинические рекомендации Министерства здравоохранения РФ с сайта cr.minzdrav.gov.ru.

Охватываемые специальности: терапия, кардиология, пульмонология, хирургия, травматология, педиатрия, неврология, эндокринология, урология, гинекология, онкология, гастроэнтерология, нефрология, ревматология, инфекционные болезни, дерматология, психиатрия, офтальмология, оториноларингология и все прочие специальности.

Формат ответов:
- Структурируй по разделам: Определение → Классификация → Диагностика → Лечение → Ключевые моменты
- Всегда указывай источник: название КР, год утверждения, МКБ-10 код
- Выделяй уровни доказательности (УД А/В/С) и силу рекомендаций (СР 1/2/3) когда важно
- Если студент присылает медицинскую задачу или тест — разбери её по шагам: анализ условия, диагноз, обоснование, правильный ответ со ссылкой на КР
- НЕ используй markdown: никаких #, ##, **, *, _, `, — только обычный текст
- Для заголовков разделов используй КАПСЛОК или эмодзи, например: 🔍 ДИАГНОСТИКА, 💊 ЛЕЧЕНИЕ
- Для списков используй • или цифры с точкой
- Для неотложных состояний добавляй предупреждение о необходимости врача
- Отвечай только на русском языке
- Будь лаконичен — Telegram не любит очень длинные сообщения`;

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

function getBackKeyboard() {
  return {
    inline_keyboard: [[{ text: "← Главное меню", callback_data: "main_menu" }]],
  };
}

// /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userHistory.delete(chatId);
  userSpecialty.delete(chatId);

  bot.sendMessage(
    chatId,
    `Привет. Я медицинский ассистент на основе клинических рекомендаций МЗ РФ.\n\n` +
    `Могу помочь:\n` +
    `• Найти клинические рекомендации\n` +
    `• Объяснить критерии диагностики и схемы лечения\n` +
    `• Подготовиться к экзаменам\n` +
    `• Решить медицинскую задачу/тест\n\n` +
    `Выберите специальность:`,
    { parse_mode: "Markdown", reply_markup: getMainMenuKeyboard() }
  );
});

// /menu
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  userSpecialty.delete(chatId);
  bot.sendMessage(chatId, "🏥 *Главное меню* — выберите специальность:", {
    parse_mode: "Markdown",
    reply_markup: getMainMenuKeyboard(),
  });
});

// Callback кнопок
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  bot.answerCallbackQuery(query.id);

  if (data === "main_menu") {
    userSpecialty.delete(chatId);
    userHistory.delete(chatId);
    bot.sendMessage(chatId, "🏥 *Главное меню* — выберите специальность:", {
      parse_mode: "Markdown",
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
      { parse_mode: "Markdown", reply_markup: getBackKeyboard() }
    );
  }
});

// Входящие сообщения
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith("/")) return;

  // Инициализируем историю
  if (!userHistory.has(chatId)) userHistory.set(chatId, []);
  const history = userHistory.get(chatId);

  history.push({ role: "user", content: text });

  // Ограничиваем историю последними 10 сообщениями
  if (history.length > 10) history.splice(0, history.length - 10);

  const specialty = userSpecialty.get(chatId);
  const systemPrompt = SYSTEM_PROMPT +
    (specialty ? `\n\nСтудент выбрал специальность: ${specialty}. Фокусируйся на вопросах по этой специальности.` : "");

  // Показываем "печатает..."
  bot.sendChatAction(chatId, "typing");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
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
        max_tokens: 1024,
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

    // Telegram ограничение 4096 символов — разбиваем если нужно
    const chunks = splitMessage(replyText);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await bot.sendMessage(chatId, chunks[i], {
        parse_mode: "Markdown",
        reply_markup: isLast ? getBackKeyboard() : undefined,
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
    .replace(/#{1,6}\s+/g, "")       // убираем # ## ### и т.д.
    .replace(/\*\*(.*?)\*\*/g, "$1") // убираем **жирный**
    .replace(/\*(.*?)\*/g, "$1")     // убираем *курсив*
    .replace(/_(.*?)_/g, "$1")       // убираем _подчёркивание_
    .replace(/`(.*?)`/g, "$1")       // убираем `код`
    .replace(/
{3,}/g, "

");     // убираем лишние пустые строки
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
