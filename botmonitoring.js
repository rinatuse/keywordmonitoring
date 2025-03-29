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
    { connectionRetries: 5 }
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

// Функция для проверки новых сообщений
// Функция для проверки новых сообщений
async function checkNewMessages() {
    if (!isMonitoringActive) {
        console.log('Мониторинг остановлен, пропускаем проверку');
        return;
    }

    console.log('Проверяем новые сообщения...');
    console.log('Текущие ключевые слова:', config.keywords);
    console.log('Ключевые слова для комментариев:', config.commentKeywords);

    for (const group of config.monitoredGroups) {
        try {
            console.log(`Проверяем группу ${group}...`);

            // Получаем имя канала из ссылки, если это ссылка
            const channelName = getChannelNameFromLink(group);

            // Получаем сущность группы/канала
            const entity = await client.getEntity(channelName);

            // Получаем последние сообщения
            const messages = await client.getMessages(entity, { limit: 20 });

            console.log(`Получено ${messages.length} сообщений из ${group}`);

            // Получаем ID последнего проверенного сообщения из базы данных
            let lastMessageData = await LastMessage.findOne({ groupId: group });

            if (!lastMessageData) {
                lastMessageData = new LastMessage({ groupId: group, lastMessageId: 0 });
                await lastMessageData.save();
            }

            const lastMessageId = lastMessageData.lastMessageId;

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
                    console.log(`Проверяем сообщение [ID: ${message.id}] на ключевые слова...`);
                    console.log(`Первые 100 символов сообщения: ${message.message.substring(0, 100)}...`);

                    let foundKeyword = null;
                    let shouldCheckComments = false;

                    // Проверяем основные ключевые слова
                    for (const keyword of config.keywords) {
                        // Создаем регулярное выражение из ключевого слова
                        const regex = new RegExp(keyword, 'i');
                        console.log(`Проверяем ключевое слово: '${keyword}'`);

                        // Проверяем наличие ключевого слова в тексте
                        if (regex.test(message.message)) {
                            console.log(`Найдено ключевое слово '${keyword}' в группе ${group}`);
                            foundKeyword = keyword;
                            shouldCheckComments = true; // Отмечаем, что нужно проверить комментарии

                            // Формируем ссылку на сообщение
                            const groupName = getChannelNameFromLink(group);
                            const messageLink = `https://t.me/${groupName}/${message.id}`;

                            // Ограничиваем длину сообщения
                            const maxMessageLength = 3000;
                            let messageText = message.message;

                            if (messageText.length > maxMessageLength - 200) {
                                messageText = messageText.substring(0, maxMessageLength - 250) + '...\n[Сообщение слишком длинное и было обрезано]';
                            }

                            // Отправляем уведомление
                            await bot.telegram.sendMessage(
                                TARGET_GROUP,
                                `🔍 Найдено ключевое слово '${keyword}' в группе ${group}:\n\n` +
                                `${messageText}\n\n` +
                                `🔗 Ссылка: ${messageLink}`
                            );
                            break;
                        }
                    }

                    // Если найдено ключевое слово в посте и есть ключевые слова для комментариев,
                    // проверяем комментарии к этому посту
                    if (shouldCheckComments && config.commentKeywords.length > 0) {
                        console.log(`Проверяем комментарии к сообщению [ID: ${message.id}]...`);

                        try {
                            // Проверяем, поддерживает ли сообщение комментарии
                            if (message.replies) {
                                // Получаем комментарии к посту
                                const comments = await client.getMessages(entity, {
                                    replyTo: message.id,
                                    limit: 100 // Ограничиваем количество проверяемых комментариев
                                });

                                console.log(`Получено ${comments.length} комментариев к сообщению [ID: ${message.id}]`);

                                // Проверяем каждый комментарий на наличие ключевых слов для комментариев
                                for (const comment of comments) {
                                    if (comment.message) {
                                        console.log(`Проверяем комментарий [ID: ${comment.id}] на ключевые слова для комментариев...`);

                                        for (const commentKeyword of config.commentKeywords) {
                                            const commentRegex = new RegExp(commentKeyword, 'i');

                                            if (commentRegex.test(comment.message)) {
                                                console.log(`Найдено ключевое слово '${commentKeyword}' в комментарии [ID: ${comment.id}]`);

                                                // Формируем ссылку на сообщение и комментарий
                                                const groupName = getChannelNameFromLink(group);
                                                const messageLink = `https://t.me/${groupName}/${message.id}?comment=${comment.id}`;

                                                // Ограничиваем длину комментария
                                                const maxCommentLength = 1000;
                                                let commentText = comment.message;

                                                if (commentText.length > maxCommentLength - 100) {
                                                    commentText = commentText.substring(0, maxCommentLength - 150) + '...\n[Комментарий слишком длинный и был обрезан]';
                                                }

                                                // Отправляем уведомление о найденном ключевом слове в комментарии
                                                await bot.telegram.sendMessage(
                                                    TARGET_GROUP,
                                                    `🔍 Найдено ключевое слово '${foundKeyword}' в посте и '${commentKeyword}' в комментарии в группе ${group}:\n\n` +
                                                    `Комментарий: ${commentText}\n\n` +
                                                    `🔗 Ссылка: ${messageLink}`
                                                );
                                                break; // Переходим к следующему комментарию после нахождения первого ключевого слова
                                            }
                                        }
                                    }
                                }
                            } else {
                                console.log(`Сообщение [ID: ${message.id}] не поддерживает комментарии или комментарии отключены`);
                            }
                        } catch (error) {
                            if (error.errorMessage === 'MSG_ID_INVALID') {
                                console.log(`Не удалось получить комментарии к сообщению [ID: ${message.id}]: сообщение не найдено или нет доступа к комментариям`);
                            } else {
                                console.error(`Ошибка при проверке комментариев к сообщению [ID: ${message.id}]:`, error);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Ошибка при проверке группы ${group}:`, error);
        }
    }

    console.log('Проверка завершена.');
}

// Функция для запуска мониторинга
async function startMonitoring() {
    if (isMonitoringActive) {
        return '⚠️ Мониторинг уже запущен!';
    }

    isMonitoringActive = true;

    console.log('Запускаем мониторинг...');

    // Первая проверка сразу после запуска
    await checkNewMessages().catch(console.error);

    // Устанавливаем интервал проверки
    monitoringInterval = setInterval(async () => {
        await checkNewMessages().catch(console.error);
    }, config.checkInterval * 60 * 1000);

    return '✅ Мониторинг успешно запущен! Я буду отслеживать указанные группы на наличие ключевых слов.';
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
        '📊 /status - Показать статус мониторинга'
    ).then(() => {
        showMainMenu(ctx);
    });
});

// Команда для запуска мониторинга
bot.command('start_monitoring', async (ctx) => {
    const result = await startMonitoring();
    ctx.reply(result);
});

// Команда для остановки мониторинга
bot.command('stop_monitoring', (ctx) => {
    const result = stopMonitoring();
    ctx.reply(result);
});

// Команда для проверки новых сообщений сейчас
bot.command('check_now', async (ctx) => {
    ctx.reply('🔄 Проверяю новые сообщения...');
    await checkNewMessages().catch(console.error);
    ctx.reply('✅ Проверка завершена!');
});

// Команда для добавления ключевого слова
bot.command('add_keyword', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('⚠️ Пожалуйста, укажите ключевое слово для добавления.\nПример: /add_keyword javascript');
    }

    const newKeyword = args.slice(1).join(' ');

    if (!config.keywords.includes(newKeyword)) {
        config.keywords.push(newKeyword);
        await saveConfig();
        ctx.reply(`✅ Ключевое слово '${newKeyword}' добавлено в список мониторинга.`);
    } else {
        ctx.reply(`⚠️ Ключевое слово '${newKeyword}' уже есть в списке мониторинга.`);
    }
});

// Команда для удаления ключевого слова
bot.command('remove_keyword', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('⚠️ Пожалуйста, укажите номер ключевого слова для удаления.\nПример: /remove_keyword 1');
    }

    const keywordIndex = parseInt(args[1]) - 1;

    if (isNaN(keywordIndex) || keywordIndex < 0 || keywordIndex >= config.keywords.length) {
        return ctx.reply(`⚠️ Некорректный номер. Введите число от 1 до ${config.keywords.length}.`);
    }

    const removedKeyword = config.keywords[keywordIndex];
    config.keywords.splice(keywordIndex, 1);
    await saveConfig();

    ctx.reply(`✅ Ключевое слово '${removedKeyword}' удалено из списка мониторинга.`);
});

// Команда для просмотра списка ключевых слов
bot.command('list_keywords', (ctx) => {
    if (config.keywords.length === 0) {
        return ctx.reply('📝 Список ключевых слов для мониторинга пуст.');
    }

    let message = '📝 Ключевые слова для мониторинга:\n';
    config.keywords.forEach((keyword, index) => {
        message += `${index + 1}. ${keyword}\n`;
    });

    ctx.reply(message);
});

// Команда для добавления новой группы для мониторинга
bot.command('add_group', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('⚠️ Пожалуйста, укажите группу для добавления.\nПример: /add_group @channel_name или /add_group https://t.me/channel_name');
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

        ctx.reply(`✅ Группа ${newGroup} добавлена в список мониторинга.`);
    } else {
        ctx.reply(`⚠️ Группа ${newGroup} уже есть в списке мониторинга.`);
    }
});

// Команда для удаления группы из мониторинга
bot.command('remove_group', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('⚠️ Пожалуйста, укажите номер группы для удаления.\nПример: /remove_group 1');
    }

    const groupIndex = parseInt(args[1]) - 1;

    if (isNaN(groupIndex) || groupIndex < 0 || groupIndex >= config.monitoredGroups.length) {
        return ctx.reply(`⚠️ Некорректный номер. Введите число от 1 до ${config.monitoredGroups.length}.`);
    }

    const removedGroup = config.monitoredGroups[groupIndex];
    config.monitoredGroups.splice(groupIndex, 1);
    await saveConfig();

    // Удаляем запись о последнем сообщении
    await LastMessage.deleteOne({ groupId: removedGroup });

    ctx.reply(`✅ Группа ${removedGroup} удалена из списка мониторинга.`);
});

// Команда для просмотра списка мониторинга
bot.command('list_groups', (ctx) => {
    if (config.monitoredGroups.length === 0) {
        return ctx.reply('📋 Список групп для мониторинга пуст.');
    }

    let message = '📋 Группы для мониторинга:\n';
    config.monitoredGroups.forEach((group, index) => {
        message += `${index + 1}. ${group}\n`;
    });

    ctx.reply(message);
});

// Команда для установки интервала проверки
bot.command('set_interval', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('⚠️ Пожалуйста, укажите интервал в минутах.\nПример: /set_interval 10');
    }

    const newInterval = parseInt(args[1]);

    if (isNaN(newInterval) || newInterval < 1) {
        return ctx.reply('⚠️ Некорректный интервал. Введите число больше 0.');
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

    ctx.reply(`⚙️ Интервал проверки установлен на ${newInterval} минут.`);
});

// Команда для просмотра статуса
bot.command('status', (ctx) => {
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

    ctx.reply(message, inlineKeyboard);
});

// Команды для работы с ключевыми словами комментариев
bot.command('list_comment_keywords', (ctx) => {
    if (config.commentKeywords.length === 0) {
        return ctx.reply('📝 Список ключевых слов для комментариев пуст.');
    }

    let message = '📝 Ключевые слова для комментариев:\n';
    config.commentKeywords.forEach((keyword, index) => {
        message += `${index + 1}. ${keyword}\n`;
    });

    ctx.reply(message);
});

bot.command('add_comment_keyword', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('⚠️ Пожалуйста, укажите ключевое слово для добавления в список комментариев.\nПример: /add_comment_keyword javascript');
    }

    const newKeyword = args.slice(1).join(' ');

    if (!config.commentKeywords.includes(newKeyword)) {
        config.commentKeywords.push(newKeyword);
        await saveConfig();
        ctx.reply(`✅ Ключевое слово '${newKeyword}' добавлено в список мониторинга комментариев.`);
    } else {
        ctx.reply(`⚠️ Ключевое слово '${newKeyword}' уже есть в списке мониторинга комментариев.`);
    }
});

bot.command('remove_comment_keyword', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('⚠️ Пожалуйста, укажите номер ключевого слова для удаления из списка комментариев.\nПример: /remove_comment_keyword 1');
    }

    const keywordIndex = parseInt(args[1]) - 1;

    if (isNaN(keywordIndex) || keywordIndex < 0 || keywordIndex >= config.commentKeywords.length) {
        return ctx.reply(`⚠️ Некорректный номер. Введите число от 1 до ${config.commentKeywords.length}.`);
    }

    const removedKeyword = config.commentKeywords[keywordIndex];
    config.commentKeywords.splice(keywordIndex, 1);
    await saveConfig();

    ctx.reply(`✅ Ключевое слово '${removedKeyword}' удалено из списка мониторинга комментариев.`);
});

// Обработка нажатий на кнопки меню
bot.hears('▶️ Управление', (ctx) => {
    ctx.reply('Выберите действие:', controlMenuKeyboard);
});

bot.hears('📋 Группы', (ctx) => {
    ctx.reply('Управление группами для мониторинга:', groupsMenuKeyboard);
});

bot.hears('🔍 Ключевые слова', (ctx) => {
    ctx.reply('Управление ключевыми словами:', keywordsMenuKeyboard);
});

bot.hears('⚙️ Настройки', (ctx) => {
    ctx.reply('Настройки бота:', settingsMenuKeyboard);
});

bot.hears('🔙 Назад в главное меню', (ctx) => {
    showMainMenu(ctx);
});

bot.hears('📊 Статус', (ctx) => {
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

    ctx.reply(message, inlineKeyboard);
});

bot.hears('❓ Помощь', (ctx) => {
    ctx.reply(
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
});

// Обработка кнопок управления мониторингом
bot.hears('▶️ Запустить мониторинг', async (ctx) => {
    ctx.replyWithChatAction('typing');
    const result = await startMonitoring();
    ctx.reply(result);
});

bot.hears('⏹️ Остановить мониторинг', (ctx) => {
    ctx.replyWithChatAction('typing');
    const result = stopMonitoring();
    ctx.reply(result);
});

bot.hears('🔄 Проверить сейчас', async (ctx) => {
    ctx.replyWithChatAction('typing');
    await ctx.reply('🔄 Проверяю новые сообщения...');
    await checkNewMessages().catch(console.error);
    ctx.reply('✅ Проверка завершена!');
});

// Обработка кнопок для работы с группами
bot.hears('📋 Список групп', async (ctx) => {
    ctx.replyWithChatAction('typing');
    if (config.monitoredGroups.length === 0) {
        return ctx.reply('📋 Список групп для мониторинга пуст.');
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

    ctx.reply(message, inlineKeyboard);
});

bot.hears('➕ Добавить группу', (ctx) => {
    ctx.replyWithChatAction('typing');
    ctx.reply(
        '➕ Чтобы добавить группу, отправьте команду в формате:\n' +
        '/add_group @channel_name\n' +
        'или\n' +
        '/add_group https://t.me/channel_name'
    );
});

bot.hears('➖ Удалить группу', async (ctx) => {
    ctx.replyWithChatAction('typing');
    if (config.monitoredGroups.length === 0) {
        return ctx.reply('📋 Список групп для мониторинга пуст.');
    }

    let message = '➖ Выберите группу для удаления:\n';
    const buttons = [];

    config.monitoredGroups.forEach((group, index) => {
        message += `${index + 1}. ${group}\n`;
        buttons.push([Markup.button.callback(`❌ ${index + 1}. ${group}`, `remove_group_${index}`)]);
    });

    ctx.reply(message, Markup.inlineKeyboard(buttons));
});

// Обработка кнопок для работы с ключевыми словами
bot.hears('📝 Список ключевых слов', (ctx) => {
    ctx.replyWithChatAction('typing');
    if (config.keywords.length === 0) {
        return ctx.reply('📝 Список ключевых слов для мониторинга пуст.');
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

    ctx.reply(message, inlineKeyboard);
});

bot.hears('➕ Добавить ключевое слово', (ctx) => {
    ctx.replyWithChatAction('typing');
    ctx.reply(
        '➕ Чтобы добавить ключевое слово, отправьте команду в формате:\n' +
        '/add_keyword javascript\n\n' +
        'Вы можете добавить несколько слов, разделив их запятыми:\n' +
        '/add_keyword javascript, python, telegram'
    );
});

bot.hears('➖ Удалить ключевое слово', (ctx) => {
    ctx.replyWithChatAction('typing');
    if (config.keywords.length === 0) {
        return ctx.reply('📝 Список ключевых слов для мониторинга пуст.');
    }

    let message = '➖ Выберите ключевое слово для удаления:\n';
    const buttons = [];

    config.keywords.forEach((keyword, index) => {
        message += `${index + 1}. ${keyword}\n`;
        buttons.push([Markup.button.callback(`❌ ${index + 1}. ${keyword}`, `remove_keyword_${index}`)]);
    });

    ctx.reply(message, Markup.inlineKeyboard(buttons));
});

// Обработка кнопок настроек
bot.hears('⏱️ Установить интервал', (ctx) => {
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

    ctx.reply(
        `⏱️ Текущий интервал проверки: ${config.checkInterval} минут\n\n` +
        'Выберите новый интервал или введите команду:\n' +
        '/set_interval [минуты]',
        Markup.inlineKeyboard(buttons)
    );
});

// Обработчики для новых пунктов меню
bot.hears('📝 Список ключевых слов комментариев', (ctx) => {
    ctx.replyWithChatAction('typing');
    if (config.commentKeywords.length === 0) {
        return ctx.reply('📝 Список ключевых слов для комментариев пуст.');
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

    ctx.reply(message, inlineKeyboard);
});

bot.hears('➕ Добавить ключевое слово комментариев', (ctx) => {
    ctx.replyWithChatAction('typing');
    ctx.reply(
        '➕ Чтобы добавить ключевое слово для комментариев, отправьте команду в формате:\n' +
        '/add_comment_keyword javascript\n\n' +
        'Вы можете добавить несколько слов, разделив их запятыми:\n' +
        '/add_comment_keyword javascript, python, telegram'
    );
});

bot.hears('➖ Удалить ключевое слово комментариев', (ctx) => {
    ctx.replyWithChatAction('typing');
    if (config.commentKeywords.length === 0) {
        return ctx.reply('📝 Список ключевых слов для комментариев пуст.');
    }

    let message = '➖ Выберите ключевое слово для удаления из списка комментариев:\n';
    const buttons = [];

    config.commentKeywords.forEach((keyword, index) => {
        message += `${index + 1}. ${keyword}\n`;
        buttons.push([Markup.button.callback(`❌ ${index + 1}. ${keyword}`, `remove_comment_keyword_${index}`)]);
    });

    ctx.reply(message, Markup.inlineKeyboard(buttons));
});

// Обработка нажатий на инлайн-кнопки
bot.action('start_monitoring', async (ctx) => {
    await ctx.answerCbQuery('Запускаю мониторинг...');
    const result = await startMonitoring();
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n' + result);
    // Обновляем кнопки
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
        Markup.button.callback('⏹️ Остановить мониторинг', 'stop_monitoring'),
        Markup.button.callback('🔄 Проверить сейчас', 'check_now')
    ]).reply_markup);
});

bot.action('stop_monitoring', async (ctx) => {
    await ctx.answerCbQuery('Останавливаю мониторинг...');
    const result = stopMonitoring();
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n' + result);
    // Обновляем кнопки
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
        Markup.button.callback('▶️ Запустить мониторинг', 'start_monitoring'),
        Markup.button.callback('🔄 Проверить сейчас', 'check_now')
    ]).reply_markup);
});

bot.action('check_now', async (ctx) => {
    await ctx.answerCbQuery('Проверяю новые сообщения...');
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n🔄 Проверяю новые сообщения...');
    await checkNewMessages().catch(console.error);
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Проверка завершена!');
});

// Добавление группы через инлайн кнопку
bot.action('add_group_dialog', async (ctx) => {
    await ctx.answerCbQuery();
    // Сохраняем состояние пользователя
    setUserState(ctx.from.id, { waitingForGroup: true });
    await ctx.reply('Отправьте ссылку на группу или канал (например, @channel_name или https://t.me/channel_name):');
});

// Добавление ключевого слова через инлайн кнопку
bot.action('add_keyword_dialog', async (ctx) => {
    await ctx.answerCbQuery();
    // Сохраняем состояние пользователя
    setUserState(ctx.from.id, { waitingForKeyword: true });
    await ctx.reply('Введите ключевое слово для добавления:');
});

// Обработка инлайн-кнопок для удаления групп
const groupRemovePattern = /remove_group_(\d+)/;
bot.action(groupRemovePattern, async (ctx) => {
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
});

// Обработка инлайн-кнопок для удаления ключевых слов
const keywordRemovePattern = /remove_keyword_(\d+)/;
bot.action(keywordRemovePattern, async (ctx) => {
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
});

// Обработка установки интервала через инлайн-кнопки
const intervalPattern = /set_interval_(\d+)/;
bot.action(intervalPattern, async (ctx) => {
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
});

// Обработчики для диалогов добавления ключевых слов комментариев
bot.action('add_comment_keyword_dialog', async (ctx) => {
    await ctx.answerCbQuery();
    setUserState(ctx.from.id, { waitingForCommentKeyword: true });
    await ctx.reply('Введите ключевое слово для добавления в список комментариев:');
});

// Обработчики для удаления ключевых слов комментариев
const commentKeywordRemovePattern = /remove_comment_keyword_(\d+)/;
bot.action(commentKeywordRemovePattern, async (ctx) => {
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
});

// Обработка текстовых сообщений для добавления групп и ключевых слов
bot.on('text', async (ctx) => {
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
            ctx.reply(`✅ Группа ${newGroup} добавлена в список мониторинга.`);
        } else {
            ctx.reply(`⚠️ Группа ${newGroup} уже есть в списке мониторинга.`);
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
            ctx.reply(`✅ Ключевое слово '${newKeyword}' добавлено в список мониторинга.`);
        } else {
            ctx.reply(`⚠️ Ключевое слово '${newKeyword}' уже есть в списке мониторинга.`);
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
            ctx.reply(`✅ Ключевое слово '${newKeyword}' добавлено в список мониторинга комментариев.`);
        } else {
            ctx.reply(`⚠️ Ключевое слово '${newKeyword}' уже есть в списке мониторинга комментариев.`);
        }

        // Сбрасываем состояние ожидания
        setUserState(ctx.from.id, {});
        return;
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
        await bot.telegram.sendMessage(
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