const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const input = require('input');

// Конфигурация
const API_ID = 23305163;  // Замените на ваш API_ID
const API_HASH = 'e39d80bf11e7f3464f4fdb54e0b6d71b';  // Замените на ваш API_HASH
const BOT_TOKEN = '7560225297:AAGg7FyjX51Rlbye1-hbqtWGDLd_YN3BH6Y';  // Токен вашего бота
const TARGET_GROUP = '-1002455984825';  // ID группы для уведомлений

// Список групп для мониторинга
const MONITORED_GROUPS = [
    '@tproger',
    'https://t.me/multievan',
];

// Ключевые слова для поиска
const KEYWORDS = [
    'javascript',
    'node\\.js',
    'telegram bot',
    'США'  // Добавляем ключевое слово "США", найденное в логах
];

// Путь к файлу сессии
const SESSION_FILE = 'session.json';

// Путь к файлу с ID последних сообщений
const LAST_MESSAGES_FILE = 'last_messages.json';

// Загрузка сессии, если она существует
let stringSession = new StringSession('');
if (fs.existsSync(SESSION_FILE)) {
    const sessionData = fs.readFileSync(SESSION_FILE, 'utf-8');
    stringSession = new StringSession(sessionData);
}

// Загрузка ID последних сообщений
let lastMessageIds = {};
try {
    lastMessageIds = JSON.parse(fs.readFileSync(LAST_MESSAGES_FILE, 'utf-8'));
} catch (error) {
    // Если файла нет, создаем пустой объект
    lastMessageIds = {};
    MONITORED_GROUPS.forEach(group => {
        lastMessageIds[group] = 0;
    });
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

// Функция для проверки новых сообщений
async function checkNewMessages() {
    console.log('Проверяем новые сообщения...');
    console.log('Текущие ключевые слова:', KEYWORDS);

    for (const group of MONITORED_GROUPS) {
        try {
            console.log(`Проверяем группу ${group}...`);

            // Получаем имя канала из ссылки, если это ссылка
            const channelName = getChannelNameFromLink(group);

            // Получаем сущность группы/канала
            const entity = await client.getEntity(channelName);

            // Получаем последние сообщения
            const messages = await client.getMessages(entity, { limit: 20 });

            console.log(`Получено ${messages.length} сообщений из ${group}`);

            // Перебираем сообщения в обратном порядке (от старых к новым)
            for (const message of [...messages].reverse()) {
                // Пропускаем уже проверенные сообщения
                if (message.id <= (lastMessageIds[group] || 0)) {
                    console.log(`Пропускаем сообщение [ID: ${message.id}], т.к. оно уже было проверено (последний ID: ${lastMessageIds[group] || 0})`);
                    continue;
                }

                // Обновляем ID последнего проверенного сообщения
                lastMessageIds[group] = message.id;

                // Если сообщение содержит текст, проверяем ключевые слова
                if (message.message) {
                    console.log(`Проверяем сообщение [ID: ${message.id}] на ключевые слова...`);
                    console.log(`Первые 100 символов сообщения: ${message.message.substring(0, 100)}...`);

                    for (const keyword of KEYWORDS) {
                        // Создаем регулярное выражение из ключевого слова
                        const regex = new RegExp(keyword, 'i');
                        console.log(`Проверяем ключевое слово: '${keyword}'`);

                        // Проверяем наличие ключевого слова в тексте
                        if (regex.test(message.message)) {
                            console.log(`Найдено ключевое слово '${keyword}' в группе ${group}`);

                            // Формируем ссылку на сообщение
                            const groupName = getChannelNameFromLink(group);
                            const messageLink = `https://t.me/${groupName}/${message.id}`;

                            // Ограничиваем длину сообщения, чтобы избежать ошибки "message is too long"
                            const maxMessageLength = 3000; // Максимальная длина сообщения Telegram
                            let messageText = message.message;

                            // Если текст сообщения слишком длинный, обрезаем его
                            if (messageText.length > maxMessageLength - 200) { // Оставляем место для остальной части сообщения
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
                }
            }
        } catch (error) {
            console.error(`Ошибка при проверке группы ${group}:`, error);
        }
    }

    // Сохраняем обновленные ID последних сообщений
    fs.writeFileSync(LAST_MESSAGES_FILE, JSON.stringify(lastMessageIds));

    // Выводим текущее состояние lastMessageIds для диагностики
    console.log('Текущие lastMessageIds:', JSON.stringify(lastMessageIds));
    console.log('Проверка завершена.');
}

// Функция для запуска мониторинга
async function startMonitoring() {
    console.log('Запускаем мониторинг...');

    await checkNewMessages().catch(console.error);

    // Проверяем сообщения каждые 5 минут
    setInterval(async () => {
        await checkNewMessages().catch(console.error);
    }, 5 * 60 * 1000);
}

// Команды для бота
bot.command('start', (ctx) => {
    ctx.reply('Бот мониторинга запущен! Я слежу за сообщениями в указанных группах.');
});

// Команда для добавления ключевого слова
bot.command('add_keyword', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('Пожалуйста, укажите ключевое слово для добавления. Пример: /add_keyword javascript');
    }

    const newKeyword = args[1];

    if (!KEYWORDS.includes(newKeyword)) {
        KEYWORDS.push(newKeyword);
        ctx.reply(`Ключевое слово '${newKeyword}' добавлено в список мониторинга.`);
    } else {
        ctx.reply(`Ключевое слово '${newKeyword}' уже есть в списке мониторинга.`);
    }
});

// Команда для просмотра списка ключевых слов
bot.command('list_keywords', (ctx) => {
    if (KEYWORDS.length === 0) {
        return ctx.reply('Список ключевых слов для мониторинга пуст.');
    }

    let message = 'Ключевые слова для мониторинга:\n';
    KEYWORDS.forEach((keyword, index) => {
        message += `${index + 1}. ${keyword}\n`;
    });

    ctx.reply(message);
});

bot.command('check', async (ctx) => {
    ctx.reply('Проверяю новые сообщения...');
    await checkNewMessages().catch(console.error);
    ctx.reply('Проверка завершена!');
});

// Команда для добавления новой группы для мониторинга
bot.command('add_group', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('Пожалуйста, укажите группу для добавления. Пример: /add_group @channel_name или /add_group https://t.me/channel_name');
    }

    const newGroup = args[1];

    if (!MONITORED_GROUPS.includes(newGroup)) {
        MONITORED_GROUPS.push(newGroup);
        lastMessageIds[newGroup] = 0;
        fs.writeFileSync(LAST_MESSAGES_FILE, JSON.stringify(lastMessageIds));
        ctx.reply(`Группа ${newGroup} добавлена в список мониторинга.`);
    } else {
        ctx.reply(`Группа ${newGroup} уже есть в списке мониторинга.`);
    }
});

// Команда для просмотра списка мониторинга
bot.command('list_groups', (ctx) => {
    if (MONITORED_GROUPS.length === 0) {
        return ctx.reply('Список групп для мониторинга пуст.');
    }

    let message = 'Группы для мониторинга:\n';
    MONITORED_GROUPS.forEach((group, index) => {
        message += `${index + 1}. ${group}\n`;
    });

    ctx.reply(message);
});

// Главная функция для запуска приложения
async function main() {
    console.log('Запуск приложения...');

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

    // Запускаем мониторинг
    await startMonitoring();
}

// Запускаем приложение
main().catch(console.error);

// Обработка завершения работы
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    client.disconnect();
    console.log('Приложение остановлено!');
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    client.disconnect();
    console.log('Приложение завершено!');
});