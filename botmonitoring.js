const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const input = require('input');
const mongoose = require('mongoose');



// Конфигурация
const API_ID = 23305163;
const API_HASH = 'e39d80bf11e7f3464f4fdb54e0b6d71b';
const BOT_TOKEN = '7560225297:AAGg7FyjX51Rlbye1-hbqtWGDLd_YN3BH6Y';
const TARGET_GROUP = '-1002455984825';


// Пути к файлам
const SESSION_FILE = 'session.json';

// Функция для добавления задержки
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Настройка подключения к MongoDB
mongoose.connect('mongodb://localhost:27017/telegram_monitor', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('Успешное подключение к MongoDB');
}).catch((error) => {
    console.error('Ошибка подключения к MongoDB:', error);
    process.exit(1);
});

// Определение схем MongoDB
const ConfigSchema = new mongoose.Schema({
    monitoredGroups: [String],
    keywords: [String],
    commentKeywords: [String],
    checkInterval: { type: Number, default: 5 }
});

const LastMessageSchema = new mongoose.Schema({
    groupId: { type: String, required: true, unique: true },
    lastMessageId: { type: Number, default: 0 }
});

// Создание моделей
const Config = mongoose.model('Config', ConfigSchema);
const LastMessage = mongoose.model('LastMessage', LastMessageSchema);

// Переменные для хранения данных
let config = {
    monitoredGroups: [],
    keywords: [],
    commentKeywords: [],
    checkInterval: 5 // минуты
};

// Переменная для контроля состояния мониторинга
let isMonitoringActive = false;
let monitoringInterval = null;

// Переменная для хранения найденных совпадений перед отправкой
let pendingMatches = {
    keywords: [],
    comments: []
};

// Загрузка сессии, если она существует
let stringSession = new StringSession('');
if (fs.existsSync(SESSION_FILE)) {
    const sessionData = fs.readFileSync(SESSION_FILE, 'utf-8');
    stringSession = new StringSession(sessionData);
}

// Создаем клиент Telegram
const client = new TelegramClient(
    stringSession,
    API_ID,
    API_HASH,
    {
        connectionRetries: 10,      // Увеличиваем количество повторных попыток
        useWSS: true,              // Используем более стабильное WebSocket соединение
        requestRetries: 5,          // Повторяем запросы при ошибках
        timeout: 180000,            // Увеличиваем таймаут до 3 минут (180000 мс)
        maxConcurrentDownloads: 3   // Ограничиваем количество параллельных загрузок
    }
);

// Создаем бота для отправки уведомлений
const bot = new Telegraf(BOT_TOKEN);

// Функция для получения имени канала из ссылки
function getChannelNameFromLink(groupLink) {
    if (groupLink.startsWith('https://t.me/')) {
        return groupLink.substring('https://t.me/'.length);
    } else if (groupLink.startsWith('t.me/')) {
        return groupLink.substring('t.me/'.length);
    } else if (groupLink.startsWith('@')) {
        return groupLink.substring(1);
    }
    return groupLink;
}
// Функция для безопасного выполнения запроса к Telegram API с защитой от таймаута
async function safeApiRequest(requestFunction, fallbackValue = null, timeoutMs = 60000) {
    return new Promise(async (resolve) => {
        // Создаем таймер для ограничения времени выполнения запроса
        const timeoutId = setTimeout(() => {
            console.log(`Запрос к Telegram API прерван по таймауту (${timeoutMs}ms)`);
            resolve(fallbackValue);
        }, timeoutMs);

        try {
            // Выполняем запрос
            const result = await requestFunction();
            clearTimeout(timeoutId);
            resolve(result);
        } catch (error) {
            console.error('Ошибка при выполнении запроса к Telegram API:', error);
            clearTimeout(timeoutId);
            resolve(fallbackValue);
        }
    });
}

// Модифицированная функция получения сообщений с защитой от таймаута
async function getMessagesWithTimeout(entity, params, timeoutMs = 30000) {
    return safeApiRequest(
        async () => await client.getMessages(entity, params),
        [], // Если произошел таймаут, возвращаем пустой массив
        timeoutMs
    );
}

// Функция для загрузки конфигурации из MongoDB
async function loadConfig() {
    try {
        let configData = await Config.findOne();

        if (!configData) {
            // Создаем конфигурацию по умолчанию
            configData = new Config({
                monitoredGroups: ['@tproger', 'https://t.me/multievan'],
                keywords: ['javascript', 'node\\.js', 'telegram bot', 'США'],
                commentKeywords: ['интересно', 'спасибо', 'помогите'],
                checkInterval: 5
            });
            await configData.save();
            console.log('Создана конфигурация по умолчанию');
        }

        // Обновляем глобальную переменную
        config = configData.toObject();
        console.log('Конфигурация загружена:', config);
        return config;
    } catch (error) {
        console.error('Ошибка при загрузке конфигурации:', error);
        return null;
    }
}

// Функция для сохранения конфигурации
async function saveConfig() {
    try {
        let configData = await Config.findOne();

        if (!configData) {
            configData = new Config(config);
        } else {
            configData.monitoredGroups = config.monitoredGroups;
            configData.keywords = config.keywords;
            configData.commentKeywords = config.commentKeywords;
            configData.checkInterval = config.checkInterval;
        }

        await configData.save();
        console.log('Конфигурация сохранена');
        return true;
    } catch (error) {
        console.error('Ошибка при сохранении конфигурации:', error);
        return false;
    }
}

// Функция для безопасной отправки сообщений с обработкой ошибки Too Many Requests
async function safeSendMessage(chatId, text, extra = {}) {
    try {
        await bot.telegram.sendMessage(chatId, text, extra);
        // Добавляем небольшую задержку после каждой отправки сообщения
        await delay(1000);
    } catch (error) {
        if (error.response && error.response.error_code === 429) {
            const retryAfter = error.response.parameters.retry_after || 30;
            console.log(`Слишком много запросов, ждем ${retryAfter} секунд...`);
            await delay(retryAfter * 1000 + 500); // Добавляем 0.5 сек для надежности
            // Повторная попытка отправки после ожидания
            try {
                await bot.telegram.sendMessage(chatId, text, extra);
            } catch (retryError) {
                console.error('Ошибка при повторной отправке сообщения:', retryError);
            }
        } else {
            console.error('Ошибка при отправке сообщения:', error);
        }
    }
}

// Функция для отправки накопленных совпадений
async function sendPendingMatches() {
    // Отправляем накопленные совпадения по ключевым словам
    if (pendingMatches.keywords.length > 0) {
        // Группируем совпадения по группам
        const groupedKeywords = {};
        for (const match of pendingMatches.keywords) {
            if (!groupedKeywords[match.group]) {
                groupedKeywords[match.group] = [];
            }
            groupedKeywords[match.group].push(match);
        }

        // Отправляем сгруппированные совпадения
        for (const group in groupedKeywords) {
            const matches = groupedKeywords[group];
            if (matches.length <= 3) {
                // Если мало совпадений, отправляем по одному
                for (const match of matches) {
                    await safeSendMessage(
                        TARGET_GROUP,
                        `🔍 Найдено ключевое слово '${match.keyword}' в группе ${match.group}:\n\n` +
                        `${match.messageText}\n\n` +
                        `🔗 Ссылка: ${match.messageLink}`
                    );
                }
            } else {
                // Если много совпадений, группируем их
                let message = `🔍 Найдено ${matches.length} совпадений ключевых слов в группе ${group}:\n\n`;
                for (let i = 0; i < Math.min(matches.length, 10); i++) {
                    message += `${i + 1}. '${matches[i].keyword}' - ${matches[i].messageLink}\n`;
                }
                message += matches.length > 10 ? `\n... и еще ${matches.length - 10} совпадений.` : '';
                await safeSendMessage(TARGET_GROUP, message);
            }
        }

        // Очищаем список совпадений
        pendingMatches.keywords = [];
    }

    // Отправляем накопленные совпадения в комментариях
    if (pendingMatches.comments.length > 0) {
        // Группируем совпадения по группам
        const groupedComments = {};
        for (const match of pendingMatches.comments) {
            if (!groupedComments[match.group]) {
                groupedComments[match.group] = [];
            }
            groupedComments[match.group].push(match);
        }

        // Отправляем сгруппированные совпадения
        for (const group in groupedComments) {
            const matches = groupedComments[group];
            if (matches.length <= 3) {
                // Если мало совпадений, отправляем по одному
                for (const match of matches) {
                    await safeSendMessage(
                        TARGET_GROUP,
                        `🔍 Найдено ключевое слово '${match.keyword}' в комментарии в группе ${match.group}:\n\n` +
                        `Комментарий: ${match.commentText}\n\n` +
                        `🔗 Ссылка: ${match.commentLink}`
                    );
                }
            } else {
                // Если много совпадений, группируем их
                let message = `🔍 Найдено ${matches.length} совпадений ключевых слов в комментариях группы ${group}:\n\n`;
                for (let i = 0; i < Math.min(matches.length, 10); i++) {
                    message += `${i + 1}. '${matches[i].keyword}' - ${matches[i].commentLink}\n`;
                }
                message += matches.length > 10 ? `\n... и еще ${matches.length - 10} совпадений.` : '';
                await safeSendMessage(TARGET_GROUP, message);
            }
        }

        // Очищаем список совпадений
        pendingMatches.comments = [];
    }
}

// Функция для проверки комментариев с ограничением по времени
async function checkCommentsWithTimeout(message, group, entity) {
    // Максимальное время на проверку комментариев (в мс)
    const MAX_COMMENTS_CHECK_TIME = 15000; // 15 секунд

    return new Promise((resolve) => {
        // Устанавливаем таймаут для завершения проверки комментариев
        const timeoutId = setTimeout(() => {
            console.log(`Превышено время проверки комментариев к сообщению [ID: ${message.id}], прерываем проверку`);
            resolve();
        }, MAX_COMMENTS_CHECK_TIME);

        // Запускаем проверку комментариев
        (async () => {
            try {
                console.log(`Проверяем комментарии к сообщению [ID: ${message.id}]...`);
                console.log(`Есть ли у сообщения replies:`, !!message.replies);

                if (message.replies && message.replies.replies > 0) {
                    // Получаем комментарии к посту с ограничением
                    const comments = await client.getMessages(entity, {
                        replyTo: message.id,
                        limit: 20 // Уменьшаем количество проверяемых комментариев
                    });

                    // Задержка после получения комментариев
                    await delay(1000);

                    console.log(`Получено ${comments.length} комментариев к сообщению [ID: ${message.id}]`);

                    // Проверяем каждый комментарий
                    for (const comment of comments) {
                        if (comment.message) {
                            console.log(`Проверяем комментарий [ID: ${comment.id}] на ключевые слова для комментариев...`);

                            for (const commentKeyword of config.commentKeywords) {
                                const commentRegex = new RegExp(commentKeyword, 'i');

                                if (commentRegex.test(comment.message)) {
                                    console.log(`Найдено ключевое слово '${commentKeyword}' в комментарии [ID: ${comment.id}]`);

                                    // Формируем ссылку на комментарий
                                    const groupName = getChannelNameFromLink(group);
                                    const commentLink = `https://t.me/${groupName}/${message.id}?comment=${comment.id}`;

                                    // Ограничиваем длину комментария
                                    const maxCommentLength = 1000;
                                    let commentText = comment.message;

                                    if (commentText.length > maxCommentLength - 100) {
                                        commentText = commentText.substring(0, maxCommentLength - 150) + '...\n[Комментарий слишком длинный и был обрезан]';
                                    }

                                    // Добавляем в список ожидающих отправки комментариев
                                    pendingMatches.comments.push({
                                        group,
                                        keyword: commentKeyword,
                                        commentText,
                                        commentLink,
                                        messageId: message.id,
                                        commentId: comment.id
                                    });

                                    break;
                                }
                            }
                        }
                    }
                } else {
                    console.log(`Сообщение [ID: ${message.id}] не поддерживает комментарии или комментарии отключены`);
                }
            } catch (error) {
                console.error(`Ошибка при проверке комментариев к сообщению [ID: ${message.id}]:`, error);
            } finally {
                // Очищаем таймаут и завершаем проверку
                clearTimeout(timeoutId);
                resolve();
            }
        })();
    });
}

// Функция для проверки сообщения на ключевые слова
async function checkMessageForKeywords(message, group, entity) {
    try {
        console.log(`Первые 100 символов сообщения: ${message.message.substring(0, 100)}...`);

        // Проверяем основные ключевые слова
        for (const keyword of config.keywords) {
            // Создаем регулярное выражение из ключевого слова
            const regex = new RegExp(keyword, 'i');
            console.log(`Проверяем ключевое слово: '${keyword}'`);

            // Проверяем наличие ключевого слова в тексте
            if (regex.test(message.message)) {
                console.log(`Найдено ключевое слово '${keyword}' в группе ${group}`);

                // Формируем ссылку на сообщение
                const groupName = getChannelNameFromLink(group);
                const messageLink = `https://t.me/${groupName}/${message.id}`;

                // Ограничиваем длину сообщения
                const maxMessageLength = 3000;
                let messageText = message.message;

                if (messageText.length > maxMessageLength - 200) {
                    messageText = messageText.substring(0, maxMessageLength - 250) + '...\n[Сообщение слишком длинное и было обрезано]';
                }

                // Добавляем в список ожидающих отправки совпадений
                pendingMatches.keywords.push({
                    group,
                    keyword,
                    messageText,
                    messageLink
                });

                break;
            }
        }

        // Проверяем комментарии только если есть ключевые слова для комментариев
        if (config.commentKeywords.length > 0) {
            // Проверяем наличие комментариев с ограничением по времени
            await checkCommentsWithTimeout(message, group, entity);
        }
    } catch (error) {
        console.error(`Ошибка при проверке сообщения [ID: ${message.id}]:`, error);
    }
}

// Функция для проверки новых сообщений

async function checkNewMessages() {
    if (!isMonitoringActive) {
        console.log('Мониторинг остановлен, пропускаем проверку');
        return;
    }

    console.log('Начинаем проверку...');

    try {
        // Очищаем накопленные совпадения
        pendingMatches = {
            keywords: [],
            comments: []
        };

        // Проверяем каждую группу
        for (const group of config.monitoredGroups) {
            try {
                await checkGroupMessages(group);
            } catch (error) {
                console.error(`Ошибка при проверке группы ${group}:`, error);
            }

            // Добавляем задержку между группами
            await delay(1000);
        }

        // Отправляем накопленные совпадения
        if (pendingMatches.keywords.length > 0 || pendingMatches.comments.length > 0) {
            await sendPendingMatches();
        }

        console.log('Проверка завершена.');
        return true;
    } catch (error) {
        console.error('Ошибка при выполнении проверки:', error);
        return false;
    } finally {
        isChecking = false; // Сбрасываем флаг проверки
    }
}

// Функция для запуска мониторинга
async function startMonitoring() {
    if (isMonitoringActive) {
        return '⚠️ Мониторинг уже запущен!';
    }

    isMonitoringActive = true;
    console.log('Запускаем мониторинг...');

    // Отправляем сообщение о запуске мониторинга
    try {
        await safeSendMessage(TARGET_GROUP, '✅ Мониторинг запущен! Первая проверка будет выполнена через 10 секунд.');
    } catch (error) {
        console.error('Ошибка при отправке сообщения о запуске мониторинга:', error);
    }

    // Запускаем первую проверку через 10 секунд
    setTimeout(() => {
        runCheckProcess();
    }, 10000);

    // Устанавливаем интервал проверки (не ждем завершения предыдущей проверки)
    monitoringInterval = setInterval(() => {
        if (!isChecking) {
            runCheckProcess();
        } else {
            console.log('Предыдущая проверка еще выполняется, пропускаем новую проверку');
        }
    }, config.checkInterval * 60 * 1000);

    return '✅ Мониторинг успешно запущен! Я буду отслеживать указанные группы на наличие ключевых слов.';
}

// Флаг, указывающий на то, что проверка уже выполняется
let isChecking = false;

function runCheckProcess() {
    if (isChecking) {
        console.log('Проверка уже выполняется, пропускаем');
        return;
    }

    isChecking = true;

    // Запускаем проверку в отдельном процессе
    setTimeout(async () => {
        try {
            await checkNewMessages().catch(console.error);
        } catch (error) {
            console.error('Ошибка при выполнении проверки:', error);
        } finally {
            isChecking = false; // Сбрасываем флаг проверки после завершения
        }
    }, 0);
}

// Ограничение количества сообщений для проверки в одной группе
const MAX_MESSAGES_PER_CHECK = 5;

// Функция для проверки новых сообщений (полностью переработанная)
async function checkGroupMessages(group) {
    try {
        console.log(`Проверяем группу ${group}...`);

        // Получаем имя канала из ссылки
        const channelName = getChannelNameFromLink(group);

        // Получаем сущность группы/канала с защитой от таймаута
        const entity = await safeApiRequest(
            async () => await client.getEntity(channelName),
            null,
            30000 // 30 секунд на получение сущности
        );

        if (!entity) {
            console.log(`Не удалось получить сущность для группы ${group}, пропускаем`);
            return false;
        }

        // Получаем ID последнего проверенного сообщения из базы данных
        let lastMessageData = await LastMessage.findOne({ groupId: group });

        if (!lastMessageData) {
            lastMessageData = new LastMessage({ groupId: group, lastMessageId: 0 });
            await lastMessageData.save();
        }

        const lastMessageId = lastMessageData.lastMessageId;

        // Получаем последние сообщения с защитой от таймаута
        const messages = await getMessagesWithTimeout(entity, { limit: 20 }, 30000);

        if (messages.length === 0) {
            console.log(`Не удалось получить сообщения для группы ${group} или группа пуста`);
            return false;
        }

        console.log(`Получено ${messages.length} сообщений из ${group}`);

        // Задержка после получения сообщений
        await delay(1000);

        // Перебираем сообщения в обратном порядке (от старых к новым)
        for (const message of [...messages].reverse()) {
            // Пропускаем уже проверенные сообщения
            if (message.id <= lastMessageId) {
                console.log(`Пропускаем сообщение [ID: ${message.id}], т.к. оно уже было проверено (последний ID: ${lastMessageId})`);
                continue;
            }

            // Обновляем ID последнего проверенного сообщения в базе данных
            await LastMessage.findOneAndUpdate(
                { groupId: group },
                { lastMessageId: message.id },
                { upsert: true }
            );

            // Если сообщение содержит текст, проверяем ключевые слова
            if (message.message) {
                // Проверяем сообщение на ключевые слова
                await checkMessageKeywords(message, group, entity);
            }

            // Добавляем задержку между проверками сообщений
            await delay(200);
        }

        console.log(`Проверка группы ${group} завершена.`);
        return true;
    } catch (error) {
        console.error(`Ошибка при проверке группы ${group}:`, error);
        return false;
    }
}

// Функция для проверки ключевых слов в сообщении
async function checkMessageKeywords(message, group, entity) {
    try {
        console.log(`Проверяем сообщение [ID: ${message.id}] на ключевые слова...`);
        console.log(`Первые 100 символов сообщения: ${message.message.substring(0, 100)}...`);

        // Проверяем основные ключевые слова
        for (const keyword of config.keywords) {
            // Создаем регулярное выражение из ключевого слова
            const regex = new RegExp(keyword, 'i');
            console.log(`Проверяем ключевое слово: '${keyword}'`);

            // Проверяем наличие ключевого слова в тексте
            if (regex.test(message.message)) {
                console.log(`Найдено ключевое слово '${keyword}' в группе ${group}`);

                // Формируем ссылку на сообщение
                const groupName = getChannelNameFromLink(group);
                const messageLink = `https://t.me/${groupName}/${message.id}`;

                // Ограничиваем длину сообщения
                const maxMessageLength = 3000;
                let messageText = message.message;

                if (messageText.length > maxMessageLength - 200) {
                    messageText = messageText.substring(0, maxMessageLength - 250) + '...\n[Сообщение слишком длинное и было обрезано]';
                }

                // Добавляем в список ожидающих отправки совпадений
                pendingMatches.keywords.push({
                    group,
                    keyword,
                    messageText,
                    messageLink
                });

                break;
            }
        }

        // Проверяем комментарии только если есть ключевые слова для комментариев
        if (config.commentKeywords.length > 0) {
            await checkCommentsWithSafetyTimeout(message, group, entity);
        }
    } catch (error) {
        console.error(`Ошибка при проверке ключевых слов в сообщении [ID: ${message.id}]:`, error);
    }
}


// Функция для безопасной проверки комментариев с защитой от таймаута
async function checkCommentsWithSafetyTimeout(message, group, entity) {
    console.log(`Проверяем комментарии к сообщению [ID: ${message.id}]...`);
    console.log(`Есть ли у сообщения replies:`, !!message.replies);

    if (!message.replies || !message.replies.replies || message.replies.replies === 0) {
        console.log(`Сообщение [ID: ${message.id}] не имеет комментариев`);
        return;
    }

    try {
        // Получаем комментарии с защитой от таймаута
        const comments = await getMessagesWithTimeout(
            entity,
            { replyTo: message.id, limit: 50 },
            30000 // 30 секунд на получение комментариев
        );

        if (comments.length === 0) {
            console.log(`Не удалось получить комментарии к сообщению [ID: ${message.id}] или комментариев нет`);
            return;
        }

        console.log(`Получено ${comments.length} комментариев к сообщению [ID: ${message.id}]`);

        // Проверяем каждый комментарий на наличие ключевых слов для комментариев
        for (const comment of comments) {
            if (comment.message) {
                console.log(`Проверяем комментарий [ID: ${comment.id}] на ключевые слова для комментариев...`);

                for (const commentKeyword of config.commentKeywords) {
                    const commentRegex = new RegExp(commentKeyword, 'i');

                    if (commentRegex.test(comment.message)) {
                        console.log(`Найдено ключевое слово '${commentKeyword}' в комментарии [ID: ${comment.id}]`);

                        // Формируем ссылку на комментарий
                        const groupName = getChannelNameFromLink(group);
                        const commentLink = `https://t.me/${groupName}/${message.id}?comment=${comment.id}`;

                        // Ограничиваем длину комментария
                        const maxCommentLength = 1000;
                        let commentText = comment.message;

                        if (commentText.length > maxCommentLength - 100) {
                            commentText = commentText.substring(0, maxCommentLength - 150) + '...\n[Комментарий слишком длинный и был обрезан]';
                        }

                        // Добавляем в список ожидающих отправки комментариев
                        pendingMatches.comments.push({
                            group,
                            keyword: commentKeyword,
                            commentText,
                            commentLink,
                            messageId: message.id,
                            commentId: comment.id
                        });

                        break; // Переходим к следующему комментарию после нахождения первого ключевого слова
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Ошибка при проверке комментариев к сообщению [ID: ${message.id}]:`, error);
    }
}

// Функция для остановки мониторинга
function stopMonitoring() {
    if (!isMonitoringActive) {
        return '⚠️ Мониторинг уже остановлен!';
    }

    isMonitoringActive = false;

    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }

    console.log('Мониторинг остановлен');
    return '🛑 Мониторинг остановлен. Чтобы возобновить, используйте команду /start_monitoring';
}

// Создаем объект для хранения состояний пользователей
const userStates = {};

// Функция для установки состояния пользователя
function setUserState(userId, state) {
    userStates[userId] = state;
}

// Функция для получения состояния пользователя
function getUserState(userId) {
    return userStates[userId] || {};
}

// Клавиатуры меню
const mainMenuKeyboard = Markup.keyboard([
    ['▶️ Управление', '📋 Группы'],
    ['🔍 Ключевые слова', '⚙️ Настройки'],
    ['📊 Статус', '❓ Помощь']
]).resize();

const controlMenuKeyboard = Markup.keyboard([
    ['▶️ Запустить мониторинг', '⏹️ Остановить мониторинг'],
    ['🔄 Проверить сейчас'],
    ['🔙 Назад в главное меню']
]).resize();

const groupsMenuKeyboard = Markup.keyboard([
    ['📋 Список групп', '➕ Добавить группу'],
    ['➖ Удалить группу'],
    ['🔙 Назад в главное меню']
]).resize();

const keywordsMenuKeyboard = Markup.keyboard([
    ['📝 Список ключевых слов', '➕ Добавить ключевое слово'],
    ['➖ Удалить ключевое слово'],
    ['📝 Список ключевых слов комментариев', '➕ Добавить ключевое слово комментариев'],
    ['➖ Удалить ключевое слово комментариев'],
    ['🔙 Назад в главное меню']
]).resize();

const settingsMenuKeyboard = Markup.keyboard([
    ['⏱️ Установить интервал'],
    ['🔙 Назад в главное меню']
]).resize();

// Функция для отображения главного меню
function showMainMenu(ctx) {
    return ctx.reply(
        '👋 Выберите раздел меню:',
        mainMenuKeyboard
    );
}

// Команды для бота
bot.command('start', (ctx) => {
    ctx.reply(
        '👋 Привет! Я бот для мониторинга сообщений в Telegram-каналах.\n\n' +
        'Вы можете управлять мной через меню кнопок или с помощью команд:\n' +
        '▶️ /start_monitoring - Запустить мониторинг\n' +
        '⏹️ /stop_monitoring - Остановить мониторинг\n' +
        '🔍 /check_now - Проверить новые сообщения сейчас\n' +
        '📋 /list_groups - Показать список групп для мониторинга\n' +
        '➕ /add_group [ссылка] - Добавить группу в мониторинг\n' +
        '➖ /remove_group [номер] - Удалить группу из мониторинга\n' +
        '📝 /list_keywords - Показать список ключевых слов\n' +
        '➕ /add_keyword [слово] - Добавить ключевое слово\n' +
        '➖ /remove_keyword [номер] - Удалить ключевое слово\n' +
        '⚙️ /set_interval [минуты] - Установить интервал проверки\n' +
        '📊 /status - Показать статус мониторинга' +
        '\n🔄 /reset_counters - Сбросить счетчики последних сообщений'
    ).then(() => {
        showMainMenu(ctx);
    });
});

// Команда для запуска мониторинга
bot.command('start_monitoring', async (ctx) => {
    try {
        const result = await startMonitoring();
        await safeSendMessage(ctx.chat.id, result);
    } catch (error) {
        console.error('Ошибка при запуске мониторинга:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при запуске мониторинга.');
    }
});

// Команда для остановки мониторинга
bot.command('stop_monitoring', async (ctx) => {
    try {
        const result = stopMonitoring();
        await safeSendMessage(ctx.chat.id, result);
    } catch (error) {
        console.error('Ошибка при остановке мониторинга:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при остановке мониторинга.');
    }
});

// Команда для проверки новых сообщений сейчас
bot.command('check_now', async (ctx) => {
    try {
        await safeSendMessage(ctx.chat.id, '🔄 Проверяю новые сообщения...');
        await checkNewMessages().catch(console.error);
        await safeSendMessage(ctx.chat.id, '✅ Проверка завершена!');
    } catch (error) {
        console.error('Ошибка при проверке новых сообщений:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при проверке новых сообщений.');
    }
});

// Команда для добавления ключевого слова
bot.command('add_keyword', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return safeSendMessage(ctx.chat.id, '⚠️ Пожалуйста, укажите ключевое слово для добавления.\nПример: /add_keyword javascript');
        }

        const newKeyword = args.slice(1).join(' ');

        if (!config.keywords.includes(newKeyword)) {
            config.keywords.push(newKeyword);
            await saveConfig();
            await safeSendMessage(ctx.chat.id, `✅ Ключевое слово '${newKeyword}' добавлено в список мониторинга.`);
        } else {
            await safeSendMessage(ctx.chat.id, `⚠️ Ключевое слово '${newKeyword}' уже есть в списке мониторинга.`);
        }
    } catch (error) {
        console.error('Ошибка при добавлении ключевого слова:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при добавлении ключевого слова.');
    }
});

// Команда для удаления ключевого слова
bot.command('remove_keyword', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return safeSendMessage(ctx.chat.id, '⚠️ Пожалуйста, укажите номер ключевого слова для удаления.\nПример: /remove_keyword 1');
        }

        const keywordIndex = parseInt(args[1]) - 1;

        if (isNaN(keywordIndex) || keywordIndex < 0 || keywordIndex >= config.keywords.length) {
            return safeSendMessage(ctx.chat.id, `⚠️ Некорректный номер. Введите число от 1 до ${config.keywords.length}.`);
        }

        const removedKeyword = config.keywords[keywordIndex];
        config.keywords.splice(keywordIndex, 1);
        await saveConfig();

        await safeSendMessage(ctx.chat.id, `✅ Ключевое слово '${removedKeyword}' удалено из списка мониторинга.`);
    } catch (error) {
        console.error('Ошибка при удалении ключевого слова:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при удалении ключевого слова.');
    }
});

// Команда для просмотра списка ключевых слов
bot.command('list_keywords', async (ctx) => {
    try {
        if (config.keywords.length === 0) {
            return safeSendMessage(ctx.chat.id, '📝 Список ключевых слов для мониторинга пуст.');
        }

        let message = '📝 Ключевые слова для мониторинга:\n';
        config.keywords.forEach((keyword, index) => {
            message += `${index + 1}. ${keyword}\n`;
        });

        await safeSendMessage(ctx.chat.id, message);
    } catch (error) {
        console.error('Ошибка при отображении списка ключевых слов:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении списка ключевых слов.');
    }
});

// Команда для добавления новой группы для мониторинга
bot.command('add_group', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return safeSendMessage(ctx.chat.id, '⚠️ Пожалуйста, укажите группу для добавления.\nПример: /add_group @channel_name или /add_group https://t.me/channel_name');
        }

        const newGroup = args[1];

        if (!config.monitoredGroups.includes(newGroup)) {
            config.monitoredGroups.push(newGroup);
            await saveConfig();

            // Создаем запись для отслеживания последнего сообщения
            await LastMessage.findOneAndUpdate(
                { groupId: newGroup },
                { lastMessageId: 0 },
                { upsert: true }
            );

            await safeSendMessage(ctx.chat.id, `✅ Группа ${newGroup} добавлена в список мониторинга.`);
        } else {
            await safeSendMessage(ctx.chat.id, `⚠️ Группа ${newGroup} уже есть в списке мониторинга.`);
        }
    } catch (error) {
        console.error('Ошибка при добавлении группы:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при добавлении группы.');
    }
});

// Команда для удаления группы из мониторинга
bot.command('remove_group', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return safeSendMessage(ctx.chat.id, '⚠️ Пожалуйста, укажите номер группы для удаления.\nПример: /remove_group 1');
        }

        const groupIndex = parseInt(args[1]) - 1;

        if (isNaN(groupIndex) || groupIndex < 0 || groupIndex >= config.monitoredGroups.length) {
            return safeSendMessage(ctx.chat.id, `⚠️ Некорректный номер. Введите число от 1 до ${config.monitoredGroups.length}.`);
        }

        const removedGroup = config.monitoredGroups[groupIndex];
        config.monitoredGroups.splice(groupIndex, 1);
        await saveConfig();

        // Удаляем запись о последнем сообщении
        await LastMessage.deleteOne({ groupId: removedGroup });

        await safeSendMessage(ctx.chat.id, `✅ Группа ${removedGroup} удалена из списка мониторинга.`);
    } catch (error) {
        console.error('Ошибка при удалении группы:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при удалении группы.');
    }
});

// Команда для просмотра списка мониторинга
bot.command('list_groups', async (ctx) => {
    try {
        if (config.monitoredGroups.length === 0) {
            return safeSendMessage(ctx.chat.id, '📋 Список групп для мониторинга пуст.');
        }

        let message = '📋 Группы для мониторинга:\n';
        config.monitoredGroups.forEach((group, index) => {
            message += `${index + 1}. ${group}\n`;
        });

        await safeSendMessage(ctx.chat.id, message);
    } catch (error) {
        console.error('Ошибка при отображении списка групп:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении списка групп.');
    }
});

// Команда для установки интервала проверки
bot.command('set_interval', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return safeSendMessage(ctx.chat.id, '⚠️ Пожалуйста, укажите интервал в минутах.\nПример: /set_interval 10');
        }

        const newInterval = parseInt(args[1]);

        if (isNaN(newInterval) || newInterval < 1) {
            return safeSendMessage(ctx.chat.id, '⚠️ Некорректный интервал. Введите число больше 0.');
        }

        config.checkInterval = newInterval;
        await saveConfig();

        // Если мониторинг активен, перезапускаем с новым интервалом
        if (isMonitoringActive && monitoringInterval) {
            clearInterval(monitoringInterval);
            monitoringInterval = setInterval(async () => {
                await checkNewMessages().catch(console.error);
            }, config.checkInterval * 60 * 1000);
        }

        await safeSendMessage(ctx.chat.id, `⚙️ Интервал проверки установлен на ${newInterval} минут.`);
    } catch (error) {
        console.error('Ошибка при установке интервала:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при установке интервала.');
    }
});

// Команда для просмотра статуса
bot.command('status', async (ctx) => {
    try {
        const status = isMonitoringActive ? '✅ Активен' : '🛑 Остановлен';

        let message = `📊 Статус мониторинга: ${status}\n`;
        message += `⏱️ Интервал проверки: ${config.checkInterval} минут\n`;
        message += `👁️ Групп в мониторинге: ${config.monitoredGroups.length}\n`;
        message += `🔍 Ключевых слов: ${config.keywords.length}\n`;
        message += `💬 Ключевых слов для комментариев: ${config.commentKeywords.length}`;

        // Создаем инлайн-клавиатуру с кнопками управления
        const inlineKeyboard = isMonitoringActive
            ? Markup.inlineKeyboard([
                Markup.button.callback('⏹️ Остановить мониторинг', 'stop_monitoring'),
                Markup.button.callback('🔄 Проверить сейчас', 'check_now')
            ])
            : Markup.inlineKeyboard([
                Markup.button.callback('▶️ Запустить мониторинг', 'start_monitoring'),
                Markup.button.callback('🔄 Проверить сейчас', 'check_now')
            ]);

        await safeSendMessage(ctx.chat.id, message, inlineKeyboard);
    } catch (error) {
        console.error('Ошибка при отображении статуса:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении статуса.');
    }
});

bot.command('reset_counters', async (ctx) => {
    try {
        await resetLastMessageIds();
        await safeSendMessage(ctx.chat.id, '✅ Счетчики последних сообщений сброшены. При следующей проверке будут просканированы все сообщения.');
    } catch (error) {
        console.error('Ошибка при выполнении команды reset_counters:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при сбросе счетчиков.');
    }
});

// Команды для работы с ключевыми словами комментариев
bot.command('list_comment_keywords', async (ctx) => {
    try {
        if (config.commentKeywords.length === 0) {
            return safeSendMessage(ctx.chat.id, '📝 Список ключевых слов для комментариев пуст.');
        }

        let message = '📝 Ключевые слова для комментариев:\n';
        config.commentKeywords.forEach((keyword, index) => {
            message += `${index + 1}. ${keyword}\n`;
        });

        await safeSendMessage(ctx.chat.id, message);
    } catch (error) {
        console.error('Ошибка при отображении списка ключевых слов комментариев:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении списка ключевых слов комментариев.');
    }
});

bot.command('add_comment_keyword', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return safeSendMessage(ctx.chat.id, '⚠️ Пожалуйста, укажите ключевое слово для добавления в список комментариев.\nПример: /add_comment_keyword javascript');
        }

        const newKeyword = args.slice(1).join(' ');

        if (!config.commentKeywords.includes(newKeyword)) {
            config.commentKeywords.push(newKeyword);
            await saveConfig();
            await safeSendMessage(ctx.chat.id, `✅ Ключевое слово '${newKeyword}' добавлено в список мониторинга комментариев.`);
        } else {
            await safeSendMessage(ctx.chat.id, `⚠️ Ключевое слово '${newKeyword}' уже есть в списке мониторинга комментариев.`);
        }
    } catch (error) {
        console.error('Ошибка при добавлении ключевого слова для комментариев:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при добавлении ключевого слова для комментариев.');
    }
});

bot.command('remove_comment_keyword', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return safeSendMessage(ctx.chat.id, '⚠️ Пожалуйста, укажите номер ключевого слова для удаления из списка комментариев.\nПример: /remove_comment_keyword 1');
        }

        const keywordIndex = parseInt(args[1]) - 1;

        if (isNaN(keywordIndex) || keywordIndex < 0 || keywordIndex >= config.commentKeywords.length) {
            return safeSendMessage(ctx.chat.id, `⚠️ Некорректный номер. Введите число от 1 до ${config.commentKeywords.length}.`);
        }

        const removedKeyword = config.commentKeywords[keywordIndex];
        config.commentKeywords.splice(keywordIndex, 1);
        await saveConfig();

        await safeSendMessage(ctx.chat.id, `✅ Ключевое слово '${removedKeyword}' удалено из списка мониторинга комментариев.`);
    } catch (error) {
        console.error('Ошибка при удалении ключевого слова для комментариев:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при удалении ключевого слова для комментариев.');
    }
});

// Обработка нажатий на кнопки меню
bot.hears('▶️ Управление', async (ctx) => {
    try {
        await safeSendMessage(ctx.chat.id, 'Выберите действие:', controlMenuKeyboard);
    } catch (error) {
        console.error('Ошибка при открытии меню управления:', error);
    }
});

bot.hears('📋 Группы', async (ctx) => {
    try {
        await safeSendMessage(ctx.chat.id, 'Управление группами для мониторинга:', groupsMenuKeyboard);
    } catch (error) {
        console.error('Ошибка при открытии меню групп:', error);
    }
});

bot.hears('🔍 Ключевые слова', async (ctx) => {
    try {
        await safeSendMessage(ctx.chat.id, 'Управление ключевыми словами:', keywordsMenuKeyboard);
    } catch (error) {
        console.error('Ошибка при открытии меню ключевых слов:', error);
    }
});

bot.hears('⚙️ Настройки', async (ctx) => {
    try {
        await safeSendMessage(ctx.chat.id, 'Настройки бота:', settingsMenuKeyboard);
    } catch (error) {
        console.error('Ошибка при открытии меню настроек:', error);
    }
});

bot.hears('🔙 Назад в главное меню', async (ctx) => {
    try {
        await showMainMenu(ctx);
    } catch (error) {
        console.error('Ошибка при возврате в главное меню:', error);
    }
});

bot.hears('📊 Статус', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        const status = isMonitoringActive ? '✅ Активен' : '🛑 Остановлен';

        let message = `📊 Статус мониторинга: ${status}\n`;
        message += `⏱️ Интервал проверки: ${config.checkInterval} минут\n`;
        message += `👁️ Групп в мониторинге: ${config.monitoredGroups.length}\n`;
        message += `🔍 Ключевых слов: ${config.keywords.length}\n`;
        message += `💬 Ключевых слов для комментариев: ${config.commentKeywords.length}`;

        const inlineKeyboard = isMonitoringActive
            ? Markup.inlineKeyboard([
                Markup.button.callback('⏹️ Остановить мониторинг', 'stop_monitoring'),
                Markup.button.callback('🔄 Проверить сейчас', 'check_now')
            ])
            : Markup.inlineKeyboard([
                Markup.button.callback('▶️ Запустить мониторинг', 'start_monitoring'),
                Markup.button.callback('🔄 Проверить сейчас', 'check_now')
            ]);

        await safeSendMessage(ctx.chat.id, message, inlineKeyboard);
    } catch (error) {
        console.error('Ошибка при отображении статуса:', error);
    }
});

bot.hears('❓ Помощь', async (ctx) => {
    try {
        await safeSendMessage(
            ctx.chat.id,
            '❓ <b>Справка по использованию бота</b>\n\n' +
            '<b>▶️ Управление</b> - запуск, остановка и проверка мониторинга\n' +
            '<b>📋 Группы</b> - управление списком групп для мониторинга\n' +
            '<b>🔍 Ключевые слова</b> - управление списком ключевых слов\n' +
            '<b>⚙️ Настройки</b> - настройка интервала проверки и другие параметры\n' +
            '<b>📊 Статус</b> - информация о текущем состоянии бота\n\n' +
            'Вы также можете использовать команды напрямую:\n' +
            '/start_monitoring - запустить мониторинг\n' +
            '/stop_monitoring - остановить мониторинг\n' +
            '/check_now - проверить сейчас\n' +
            '/status - показать статус',
            { parse_mode: 'HTML' }
        );
    } catch (error) {
        console.error('Ошибка при отображении справки:', error);
    }
});

// Обработка кнопок управления мониторингом
bot.hears('▶️ Запустить мониторинг', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        const result = await startMonitoring();
        await safeSendMessage(ctx.chat.id, result);
    } catch (error) {
        console.error('Ошибка при запуске мониторинга:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при запуске мониторинга.');
    }
});

bot.hears('⏹️ Остановить мониторинг', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        const result = stopMonitoring();
        await safeSendMessage(ctx.chat.id, result);
    } catch (error) {
        console.error('Ошибка при остановке мониторинга:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при остановке мониторинга.');
    }
});

// Обработчик команды "Проверить сейчас"
bot.hears('🔄 Проверить сейчас', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');

        if (isChecking) {
            await safeSendMessage(ctx.chat.id, '⏳ Проверка уже выполняется, пожалуйста, подождите.');
            return;
        }

        await safeSendMessage(ctx.chat.id, '🔄 Запускаю проверку новых сообщений в фоновом режиме...');

        // Запускаем проверку, не дожидаясь ее завершения
        setTimeout(async () => {
            isChecking = true;
            try {
                await checkNewMessages().catch(console.error);
                await safeSendMessage(ctx.chat.id, '✅ Проверка завершена!');
            } catch (error) {
                console.error('Ошибка при проверке сообщений:', error);
                await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при проверке сообщений.');
            } finally {
                isChecking = false;
            }
        }, 100);

    } catch (error) {
        console.error('Ошибка при запуске проверки сообщений:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при запуске проверки сообщений.');
    }
});
// Обработка кнопок для работы с группами
bot.hears('📋 Список групп', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        if (config.monitoredGroups.length === 0) {
            return safeSendMessage(ctx.chat.id, '📋 Список групп для мониторинга пуст.');
        }

        let message = '📋 Группы для мониторинга:\n';
        const buttons = [];

        config.monitoredGroups.forEach((group, index) => {
            message += `${index + 1}. ${group}\n`;
            buttons.push([Markup.button.callback(`❌ Удалить ${index + 1}`, `remove_group_${index}`)]);
        });

        const inlineKeyboard = Markup.inlineKeyboard([
            ...buttons,
            [Markup.button.callback('➕ Добавить новую группу', 'add_group_dialog')]
        ]);

        await safeSendMessage(ctx.chat.id, message, inlineKeyboard);
    } catch (error) {
        console.error('Ошибка при отображении списка групп:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении списка групп.');
    }
});

bot.hears('➕ Добавить группу', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        await safeSendMessage(
            ctx.chat.id,
            '➕ Чтобы добавить группу, отправьте команду в формате:\n' +
            '/add_group @channel_name\n' +
            'или\n' +
            '/add_group https://t.me/channel_name'
        );
    } catch (error) {
        console.error('Ошибка при отображении информации о добавлении группы:', error);
    }
});

// Остальные обработчики и логика будут добавлены в следующем фрагменте
bot.hears('➖ Удалить группу', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        if (config.monitoredGroups.length === 0) {
            return safeSendMessage(ctx.chat.id, '📋 Список групп для мониторинга пуст.');
        }

        let message = '➖ Выберите группу для удаления:\n';
        const buttons = [];

        config.monitoredGroups.forEach((group, index) => {
            message += `${index + 1}. ${group}\n`;
            buttons.push([Markup.button.callback(`❌ ${index + 1}. ${group}`, `remove_group_${index}`)]);
        });

        await safeSendMessage(ctx.chat.id, message, Markup.inlineKeyboard(buttons));
    } catch (error) {
        console.error('Ошибка при отображении списка групп для удаления:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении списка групп для удаления.');
    }
});

// Обработка кнопок для работы с ключевыми словами
bot.hears('📝 Список ключевых слов', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        if (config.keywords.length === 0) {
            return safeSendMessage(ctx.chat.id, '📝 Список ключевых слов для мониторинга пуст.');
        }

        let message = '📝 Ключевые слова для мониторинга:\n';
        const buttons = [];

        config.keywords.forEach((keyword, index) => {
            message += `${index + 1}. ${keyword}\n`;
            buttons.push([Markup.button.callback(`❌ Удалить ${index + 1}`, `remove_keyword_${index}`)]);
        });

        const inlineKeyboard = Markup.inlineKeyboard([
            ...buttons,
            [Markup.button.callback('➕ Добавить новое слово', 'add_keyword_dialog')]
        ]);

        await safeSendMessage(ctx.chat.id, message, inlineKeyboard);
    } catch (error) {
        console.error('Ошибка при отображении списка ключевых слов:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении списка ключевых слов.');
    }
});

bot.hears('➕ Добавить ключевое слово', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        await safeSendMessage(
            ctx.chat.id,
            '➕ Чтобы добавить ключевое слово, отправьте команду в формате:\n' +
            '/add_keyword javascript\n\n' +
            'Вы можете добавить несколько слов, разделив их запятыми:\n' +
            '/add_keyword javascript, python, telegram'
        );
    } catch (error) {
        console.error('Ошибка при отображении информации о добавлении ключевых слов:', error);
    }
});

bot.hears('➖ Удалить ключевое слово', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        if (config.keywords.length === 0) {
            return safeSendMessage(ctx.chat.id, '📝 Список ключевых слов для мониторинга пуст.');
        }

        let message = '➖ Выберите ключевое слово для удаления:\n';
        const buttons = [];

        config.keywords.forEach((keyword, index) => {
            message += `${index + 1}. ${keyword}\n`;
            buttons.push([Markup.button.callback(`❌ ${index + 1}. ${keyword}`, `remove_keyword_${index}`)]);
        });

        await safeSendMessage(ctx.chat.id, message, Markup.inlineKeyboard(buttons));
    } catch (error) {
        console.error('Ошибка при отображении списка ключевых слов для удаления:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении списка ключевых слов для удаления.');
    }
});

// Обработка кнопок настроек
bot.hears('⏱️ Установить интервал', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        const buttons = [
            [
                Markup.button.callback('1 минута', 'set_interval_1'),
                Markup.button.callback('5 минут', 'set_interval_5'),
                Markup.button.callback('10 минут', 'set_interval_10')
            ],
            [
                Markup.button.callback('15 минут', 'set_interval_15'),
                Markup.button.callback('30 минут', 'set_interval_30'),
                Markup.button.callback('1 час', 'set_interval_60')
            ]
        ];

        await safeSendMessage(
            ctx.chat.id,
            `⏱️ Текущий интервал проверки: ${config.checkInterval} минут\n\n` +
            'Выберите новый интервал или введите команду:\n' +
            '/set_interval [минуты]',
            Markup.inlineKeyboard(buttons)
        );
    } catch (error) {
        console.error('Ошибка при отображении настроек интервала:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении настроек интервала.');
    }
});

// Обработчики для новых пунктов меню
bot.hears('📝 Список ключевых слов комментариев', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        if (config.commentKeywords.length === 0) {
            return safeSendMessage(ctx.chat.id, '📝 Список ключевых слов для комментариев пуст.');
        }

        let message = '📝 Ключевые слова для комментариев:\n';
        const buttons = [];

        config.commentKeywords.forEach((keyword, index) => {
            message += `${index + 1}. ${keyword}\n`;
            buttons.push([Markup.button.callback(`❌ Удалить ${index + 1}`, `remove_comment_keyword_${index}`)]);
        });

        const inlineKeyboard = Markup.inlineKeyboard([
            ...buttons,
            [Markup.button.callback('➕ Добавить новое слово', 'add_comment_keyword_dialog')]
        ]);

        await safeSendMessage(ctx.chat.id, message, inlineKeyboard);
    } catch (error) {
        console.error('Ошибка при отображении списка ключевых слов для комментариев:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при отображении списка ключевых слов для комментариев.');
    }
});

bot.hears('➕ Добавить ключевое слово комментариев', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        await safeSendMessage(
            ctx.chat.id,
            '➕ Чтобы добавить ключевое слово для комментариев, отправьте команду в формате:\n' +
            '/add_comment_keyword javascript\n\n' +
            'Вы можете добавить несколько слов, разделив их запятыми:\n' +
            '/add_comment_keyword javascript, python, telegram'
        );
    } catch (error) {
        console.error('Ошибка при отображении информации о добавлении ключевых слов для комментариев:', error);
    }
});

bot.hears('➖ Удалить ключевое слово комментариев', async (ctx) => {
    try {
        ctx.replyWithChatAction('typing');
        if (config.commentKeywords.length === 0) {
            return safeSendMessage(ctx.chat.id, '📝 Список ключевых слов для комментариев пуст.');
        }

        let message = '➖ Выберите ключевое слово для удаления из списка комментариев:\n';
        const buttons = [];

        config.commentKeywords.forEach((keyword, index) => {
            message += `${index + 1}. ${keyword}\n`;
            buttons.push([Markup.button.callback(`❌ ${index + 1}. ${keyword}`, `remove_comment_keyword_${index}`)]);
        });

        await safeSendMessage(ctx.chat.id, message, Markup.inlineKeyboard(buttons));
    } catch (error) {
        console.error('Ошибка при отображении списка ключевых слов комментариев для удаления:', error);
    }
});

// Обработка нажатий на инлайн-кнопки
bot.action('start_monitoring', async (ctx) => {
    try {
        await ctx.answerCbQuery('Запускаю мониторинг...');
        const result = await startMonitoring();
        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n' + result);
        // Обновляем кнопки
        await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
            Markup.button.callback('⏹️ Остановить мониторинг', 'stop_monitoring'),
            Markup.button.callback('🔄 Проверить сейчас', 'check_now')
        ]).reply_markup);
    } catch (error) {
        console.error('Ошибка при запуске мониторинга через инлайн-кнопку:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при запуске мониторинга.');
    }
});

bot.action('stop_monitoring', async (ctx) => {
    try {
        await ctx.answerCbQuery('Останавливаю мониторинг...');
        const result = stopMonitoring();
        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n' + result);
        // Обновляем кнопки
        await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
            Markup.button.callback('▶️ Запустить мониторинг', 'start_monitoring'),
            Markup.button.callback('🔄 Проверить сейчас', 'check_now')
        ]).reply_markup);
    } catch (error) {
        console.error('Ошибка при остановке мониторинга через инлайн-кнопку:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при остановке мониторинга.');
    }
});

// Обработка инлайн-кнопки "Проверить сейчас"
bot.action('check_now', async (ctx) => {
    try {
        await ctx.answerCbQuery('Запускаю проверку новых сообщений...');

        // Проверяем, выполняется ли уже проверка
        if (isChecking) {
            await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n⏳ Проверка уже выполняется. Пожалуйста, подождите.');
            return;
        }

        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n🔄 Запускаю проверку новых сообщений...');

        // Запускаем проверку в отдельном процессе
        runCheckProcess();

        // Отправляем уведомление о запуске проверки
        setTimeout(async () => {
            await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Проверка запущена в фоновом режиме. Результаты будут отправлены в чат.');
        }, 2000);

    } catch (error) {
        console.error('Ошибка при запуске проверки через инлайн-кнопку:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при запуске проверки сообщений.');
    }
});
// Добавление группы через инлайн кнопку
bot.action('add_group_dialog', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        // Сохраняем состояние пользователя
        setUserState(ctx.from.id, { waitingForGroup: true });
        await safeSendMessage(ctx.chat.id, 'Отправьте ссылку на группу или канал (например, @channel_name или https://t.me/channel_name):');
    } catch (error) {
        console.error('Ошибка при открытии диалога добавления группы:', error);
    }
});

// Добавление ключевого слова через инлайн кнопку
bot.action('add_keyword_dialog', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        // Сохраняем состояние пользователя
        setUserState(ctx.from.id, { waitingForKeyword: true });
        await safeSendMessage(ctx.chat.id, 'Введите ключевое слово для добавления:');
    } catch (error) {
        console.error('Ошибка при открытии диалога добавления ключевого слова:', error);
    }
});

// Обработка инлайн-кнопок для удаления групп
const groupRemovePattern = /remove_group_(\d+)/;
bot.action(groupRemovePattern, async (ctx) => {
    try {
        const match = ctx.callbackQuery.data.match(groupRemovePattern);
        if (!match) return await ctx.answerCbQuery('Ошибка!');

        const groupIndex = parseInt(match[1]);

        if (isNaN(groupIndex) || groupIndex < 0 || groupIndex >= config.monitoredGroups.length) {
            return await ctx.answerCbQuery('Некорректный номер группы!');
        }

        const removedGroup = config.monitoredGroups[groupIndex];
        config.monitoredGroups.splice(groupIndex, 1);
        await saveConfig();

        // Удаляем запись о последнем сообщении
        await LastMessage.deleteOne({ groupId: removedGroup });

        await ctx.answerCbQuery(`Группа ${removedGroup} удалена!`);

        // Обновляем сообщение
        if (config.monitoredGroups.length === 0) {
            await ctx.editMessageText('📋 Список групп для мониторинга пуст.');
        } else {
            let message = '📋 Группы для мониторинга:\n';
            const buttons = [];

            config.monitoredGroups.forEach((group, index) => {
                message += `${index + 1}. ${group}\n`;
                buttons.push([Markup.button.callback(`❌ Удалить ${index + 1}`, `remove_group_${index}`)]);
            });

            const inlineKeyboard = Markup.inlineKeyboard([
                ...buttons,
                [Markup.button.callback('➕ Добавить новую группу', 'add_group_dialog')]
            ]);

            await ctx.editMessageText(message, inlineKeyboard);
        }
    } catch (error) {
        console.error('Ошибка при удалении группы через инлайн-кнопку:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при удалении группы.');
    }
});

// Обработка инлайн-кнопок для удаления ключевых слов
const keywordRemovePattern = /remove_keyword_(\d+)/;
bot.action(keywordRemovePattern, async (ctx) => {
    try {
        const match = ctx.callbackQuery.data.match(keywordRemovePattern);
        if (!match) return await ctx.answerCbQuery('Ошибка!');

        const keywordIndex = parseInt(match[1]);

        if (isNaN(keywordIndex) || keywordIndex < 0 || keywordIndex >= config.keywords.length) {
            return await ctx.answerCbQuery('Некорректный номер ключевого слова!');
        }

        const removedKeyword = config.keywords[keywordIndex];
        config.keywords.splice(keywordIndex, 1);
        await saveConfig();

        await ctx.answerCbQuery(`Ключевое слово '${removedKeyword}' удалено!`);

        // Обновляем сообщение
        if (config.keywords.length === 0) {
            await ctx.editMessageText('📝 Список ключевых слов для мониторинга пуст.');
        } else {
            let message = '📝 Ключевые слова для мониторинга:\n';
            const buttons = [];

            config.keywords.forEach((keyword, index) => {
                message += `${index + 1}. ${keyword}\n`;
                buttons.push([Markup.button.callback(`❌ Удалить ${index + 1}`, `remove_keyword_${index}`)]);
            });

            const inlineKeyboard = Markup.inlineKeyboard([
                ...buttons,
                [Markup.button.callback('➕ Добавить новое слово', 'add_keyword_dialog')]
            ]);

            await ctx.editMessageText(message, inlineKeyboard);
        }
    } catch (error) {
        console.error('Ошибка при удалении ключевого слова через инлайн-кнопку:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при удалении ключевого слова.');
    }
});

// Обработка установки интервала через инлайн-кнопки
const intervalPattern = /set_interval_(\d+)/;
bot.action(intervalPattern, async (ctx) => {
    try {
        const match = ctx.callbackQuery.data.match(intervalPattern);
        if (!match) return await ctx.answerCbQuery('Ошибка!');

        const newInterval = parseInt(match[1]);

        if (isNaN(newInterval) || newInterval < 1) {
            return await ctx.answerCbQuery('Некорректный интервал!');
        }

        config.checkInterval = newInterval;
        await saveConfig();

        // Если мониторинг активен, перезапускаем с новым интервалом
        if (isMonitoringActive && monitoringInterval) {
            clearInterval(monitoringInterval);
            monitoringInterval = setInterval(async () => {
                await checkNewMessages().catch(console.error);
            }, config.checkInterval * 60 * 1000);
        }

        await ctx.answerCbQuery(`Интервал установлен на ${newInterval} минут!`);
        await ctx.editMessageText(`⏱️ Интервал проверки установлен на ${newInterval} минут.`);
    } catch (error) {
        console.error('Ошибка при установке интервала через инлайн-кнопку:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при установке интервала.');
    }
});

// Обработчики для диалогов добавления ключевых слов комментариев
bot.action('add_comment_keyword_dialog', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        setUserState(ctx.from.id, { waitingForCommentKeyword: true });
        await safeSendMessage(ctx.chat.id, 'Введите ключевое слово для добавления в список комментариев:');
    } catch (error) {
        console.error('Ошибка при открытии диалога добавления ключевого слова для комментариев:', error);
    }
});

// Обработчики для удаления ключевых слов комментариев
const commentKeywordRemovePattern = /remove_comment_keyword_(\d+)/;
bot.action(commentKeywordRemovePattern, async (ctx) => {
    try {
        const match = ctx.callbackQuery.data.match(commentKeywordRemovePattern);
        if (!match) return await ctx.answerCbQuery('Ошибка!');

        const keywordIndex = parseInt(match[1]);

        if (isNaN(keywordIndex) || keywordIndex < 0 || keywordIndex >= config.commentKeywords.length) {
            return await ctx.answerCbQuery('Некорректный номер ключевого слова!');
        }

        const removedKeyword = config.commentKeywords[keywordIndex];
        config.commentKeywords.splice(keywordIndex, 1);
        await saveConfig();

        await ctx.answerCbQuery(`Ключевое слово '${removedKeyword}' удалено из списка комментариев!`);

        // Обновляем сообщение
        if (config.commentKeywords.length === 0) {
            await ctx.editMessageText('📝 Список ключевых слов для комментариев пуст.');
        } else {
            let message = '📝 Ключевые слова для комментариев:\n';
            const buttons = [];

            config.commentKeywords.forEach((keyword, index) => {
                message += `${index + 1}. ${keyword}\n`;
                buttons.push([Markup.button.callback(`❌ Удалить ${index + 1}`, `remove_comment_keyword_${index}`)]);
            });

            const inlineKeyboard = Markup.inlineKeyboard([
                ...buttons,
                [Markup.button.callback('➕ Добавить новое слово', 'add_comment_keyword_dialog')]
            ]);

            await ctx.editMessageText(message, inlineKeyboard);
        }
    } catch (error) {
        console.error('Ошибка при удалении ключевого слова для комментариев через инлайн-кнопку:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при удалении ключевого слова для комментариев.');
    }
});

// Обработка текстовых сообщений для добавления групп и ключевых слов
bot.on('text', async (ctx) => {
    try {
        // Получаем текущее состояние пользователя
        const state = getUserState(ctx.from.id);

        // Проверяем, находимся ли мы в режиме ожидания ввода группы
        if (state.waitingForGroup) {
            const newGroup = ctx.message.text.trim();

            if (!config.monitoredGroups.includes(newGroup)) {
                config.monitoredGroups.push(newGroup);
                // Создаем запись для отслеживания последнего сообщения
                await LastMessage.findOneAndUpdate(
                    { groupId: newGroup },
                    { lastMessageId: 0 },
                    { upsert: true }
                );
                await saveConfig();
                await safeSendMessage(ctx.chat.id, `✅ Группа ${newGroup} добавлена в список мониторинга.`);
            } else {
                await safeSendMessage(ctx.chat.id, `⚠️ Группа ${newGroup} уже есть в списке мониторинга.`);
            }

            // Сбрасываем состояние ожидания
            setUserState(ctx.from.id, {});
            return;
        }

        // Проверяем, находимся ли мы в режиме ожидания ввода ключевого слова
        if (state.waitingForKeyword) {
            const newKeyword = ctx.message.text.trim();

            if (!config.keywords.includes(newKeyword)) {
                config.keywords.push(newKeyword);
                await saveConfig();
                await safeSendMessage(ctx.chat.id, `✅ Ключевое слово '${newKeyword}' добавлено в список мониторинга.`);
            } else {
                await safeSendMessage(ctx.chat.id, `⚠️ Ключевое слово '${newKeyword}' уже есть в списке мониторинга.`);
            }

            // Сбрасываем состояние ожидания
            setUserState(ctx.from.id, {});
            return;
        }

        // Проверяем, находимся ли мы в режиме ожидания ввода ключевого слова для комментариев
        if (state.waitingForCommentKeyword) {
            const newKeyword = ctx.message.text.trim();

            if (!config.commentKeywords.includes(newKeyword)) {
                config.commentKeywords.push(newKeyword);
                await saveConfig();
                await safeSendMessage(ctx.chat.id, `✅ Ключевое слово '${newKeyword}' добавлено в список мониторинга комментариев.`);
            } else {
                await safeSendMessage(ctx.chat.id, `⚠️ Ключевое слово '${newKeyword}' уже есть в списке мониторинга комментариев.`);
            }

            // Сбрасываем состояние ожидания
            setUserState(ctx.from.id, {});
            return;
        }
    } catch (error) {
        console.error('Ошибка при обработке текстового сообщения:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при обработке сообщения.');
    }
});

// Миграция данных из JSON в MongoDB при первом запуске
async function migrateFromJson() {
    try {
        // Проверяем, есть ли данные в MongoDB
        const configExists = await Config.countDocuments();
        const lastMessageExists = await LastMessage.countDocuments();

        // Если данные уже есть в MongoDB, пропускаем миграцию
        if (configExists > 0 || lastMessageExists > 0) {
            console.log('Данные уже существуют в MongoDB, пропускаем миграцию');
            return;
        }

        // Проверяем наличие JSON-файлов для миграции
        if (!fs.existsSync('config.json') || !fs.existsSync('last_messages.json')) {
            console.log('Файлы JSON для миграции не найдены');
            return;
        }

        console.log('Начинаем миграцию данных из JSON в MongoDB...');

        // Загружаем данные из JSON-файлов
        const configData = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
        const lastMessagesData = JSON.parse(fs.readFileSync('last_messages.json', 'utf-8'));

        // Сохраняем конфигурацию в MongoDB
        const newConfig = new Config({
            monitoredGroups: configData.monitoredGroups || [],
            keywords: configData.keywords || [],
            commentKeywords: configData.commentKeywords || [],
            checkInterval: configData.checkInterval || 5
        });
        await newConfig.save();

        // Сохраняем данные о последних сообщениях
        for (const [groupId, lastMessageId] of Object.entries(lastMessagesData)) {
            const newLastMessage = new LastMessage({
                groupId,
                lastMessageId
            });
            await newLastMessage.save();
        }

        console.log('Миграция данных из JSON в MongoDB успешно завершена');

        // Создаем резервные копии JSON-файлов
        fs.renameSync('config.json', 'config.json.bak');
        fs.renameSync('last_messages.json', 'last_messages.json.bak');

        console.log('Созданы резервные копии JSON-файлов');
    } catch (error) {
        console.error('Ошибка при миграции данных из JSON в MongoDB:', error);
    }
}

// Функция для сброса счетчиков последних сообщений
async function resetLastMessageIds() {
    try {
        await LastMessage.updateMany({}, { lastMessageId: 0 });
        console.log('Счетчики последних сообщений сброшены');
        return true;
    } catch (error) {
        console.error('Ошибка при сбросе счетчиков последних сообщений:', error);
        return false;
    }
}

// Команда для сброса счетчиков последних сообщений
bot.command('reset_counters', async (ctx) => {
    try {
        await resetLastMessageIds();
        await safeSendMessage(ctx.chat.id, '✅ Счетчики последних сообщений сброшены. При следующей проверке будут просканированы все сообщения.');
    } catch (error) {
        console.error('Ошибка при выполнении команды reset_counters:', error);
        await safeSendMessage(ctx.chat.id, '❌ Произошла ошибка при сбросе счетчиков.');
    }
});

// Главная функция для запуска приложения
async function main() {
    console.log('Запуск приложения...');

    // Выполняем миграцию данных из JSON в MongoDB при первом запуске
    await migrateFromJson();

    // Загружаем конфигурацию из базы данных
    const configData = await loadConfig();
    if (configData) {
        config = configData;
    }

    // Подключаемся к Telegram
    await client.start({
        phoneNumber: async () => await input.text('Введите номер телефона: '),
        password: async () => await input.text('Введите пароль от аккаунта (если требуется): '),
        phoneCode: async () => await input.text('Введите код, полученный в Telegram: '),
        onError: (err) => console.log(err),
    });

    // Сохраняем сессию
    const sessionString = client.session.save();
    fs.writeFileSync(SESSION_FILE, sessionString);

    console.log('Успешно подключились к Telegram!');

    // Запускаем бота
    bot.launch();
    console.log('Бот запущен!');

    // Отправляем сообщение, что бот запустился
    try {
        await safeSendMessage(
            TARGET_GROUP,
            '🤖 Бот мониторинга запущен и готов к работе!\n' +
            'Используйте команду /start для получения списка доступных команд.',
            mainMenuKeyboard
        );
    } catch (error) {
        console.error('Не удалось отправить стартовое сообщение:', error);
    }
}

// Запускаем приложение
main().catch(console.error);

// Обработка завершения работы
process.once('SIGINT', () => {
    stopMonitoring();
    bot.stop('SIGINT');
    client.disconnect();
    mongoose.connection.close();
    console.log('Приложение остановлено!');
});

process.once('SIGTERM', () => {
    stopMonitoring();
    bot.stop('SIGTERM');
    client.disconnect();
    mongoose.connection.close();
    console.log('Приложение завершено!');
});