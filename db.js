const mongoose = require('mongoose');

// Схема для конфигурации
const ConfigSchema = new mongoose.Schema({
    monitoredGroups: [String],
    keywords: [String],
    commentKeywords: [String],
    checkInterval: { type: Number, default: 5 },
    messageLimit: { type: Number, default: 20 }
});

// Схема для последних сообщений
const LastMessageSchema = new mongoose.Schema({
    groupId: { type: String, required: true, unique: true },
    lastMessageId: { type: Number, default: 0 }
});

// Создаем модели
const Config = mongoose.model('Config', ConfigSchema);
const LastMessage = mongoose.model('LastMessage', LastMessageSchema);

// Функция подключения к базе данных
async function connectToDatabase() {
    try {
        const password = encodeURIComponent('34A=C1lt1{QllX'); // Здесь укажите ваш настоящий пароль для пользователя rinat
        await mongoose.connect(`mongodb://rinat:${password}@92.53.105.80:27017/telegram_monitor`, {
            authSource: 'admin',
            serverSelectionTimeoutMS: 30000,
            socketTimeoutMS: 45000,
            connectTimeoutMS: 30000
        });
        console.log('Успешное подключение к MongoDB');
        return true;
    } catch (error) {
        console.error('Ошибка подключения к MongoDB:', error);
        return false;
    }
}

// Функция для получения или создания конфигурации
async function getConfig() {
    let config = await Config.findOne();

    if (!config) {
        // Создаем конфигурацию по умолчанию
        config = new Config({
            monitoredGroups: ['@tproger', 'https://t.me/multievan'],
            keywords: ['javascript', 'node\\.js', 'telegram bot', 'США'],
            commentKeywords: ['интересно', 'спасибо', 'помогите'],
            checkInterval: 5
        });
        await config.save();
        console.log('Создана конфигурация по умолчанию');
    }

    return config;
}

// Функция для сохранения конфигурации
async function saveConfig(configData) {
    let config = await Config.findOne();

    if (!config) {
        config = new Config(configData);
    } else {
        config.monitoredGroups = configData.monitoredGroups;
        config.keywords = configData.keywords;
        config.commentKeywords = configData.commentKeywords;
        config.checkInterval = configData.checkInterval;
    }

    await config.save();
    console.log('Конфигурация сохранена');
}

// Функция для получения ID последнего сообщения для группы
async function getLastMessageId(groupId) {
    let lastMessage = await LastMessage.findOne({ groupId });

    if (!lastMessage) {
        lastMessage = new LastMessage({ groupId, lastMessageId: 0 });
        await lastMessage.save();
    }

    return lastMessage.lastMessageId;
}

// Функция для обновления ID последнего сообщения
async function updateLastMessageId(groupId, messageId) {
    await LastMessage.findOneAndUpdate(
        { groupId },
        { lastMessageId: messageId },
        { upsert: true }
    );
}

// Функция для миграции данных из JSON-файлов
async function migrateFromJson(configData, lastMessagesData) {
    // Сохраняем конфигурацию
    await saveConfig(configData);

    // Сохраняем ID последних сообщений
    for (const [groupId, lastMessageId] of Object.entries(lastMessagesData)) {
        await updateLastMessageId(groupId, lastMessageId);
    }

    console.log('Миграция данных из JSON-файлов завершена');
}

module.exports = {
    connectToDatabase,
    getConfig,
    saveConfig,
    getLastMessageId,
    updateLastMessageId,
    migrateFromJson,
    models: {
        Config,
        LastMessage
    }
};