const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, PermissionsBitField, REST, Routes } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Загрузка конфигурации из JSON файла
const configPath = path.resolve(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Настройка базы данных (SQLite)
const dbPath = path.resolve(__dirname, 'parameters.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Ошибка открытия базы данных:', err.message);
  else console.log('Подключено к базе данных SQLite.');
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS whitelist (user_id TEXT PRIMARY KEY)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocked_words (word TEXT PRIMARY KEY)`);
    db.run(`CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT PRIMARY KEY, verify_role_id TEXT, verify_title TEXT, verify_description TEXT, verify_image TEXT, server_name TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS giveaways (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, channel_id TEXT, message_id TEXT, prize TEXT, duration INTEGER, winners INTEGER, conditions TEXT, end_time INTEGER, participants TEXT DEFAULT '')`);
  });
});

// Настройка бота
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Палитра цветов из конфига
const colors = {
  embed: config.colors.embed,
  buttonPrimary: config.colors.buttonPrimary,
  buttonSecondary: config.colors.buttonSecondary,
  buttonDanger: config.colors.buttonDanger,
  buttonNeutral: config.colors.buttonNeutral,
};

// Разрешённые ID для админ-панели из конфига
const allowedAdminIDs = config.admin.allowedIDs;

// Функция для повторных попыток API-запросов
const retryAttempts = config.bot.retryAttempts || 3;
const retryDelay = config.bot.retryDelay || 1000;

async function withRetry(fn, retries = retryAttempts, delay = retryDelay) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'UND_ERR_CONNECT_TIMEOUT' && i < retries - 1) {
        const currentDelay = delay * Math.pow(2, i); // Экспоненциальный backoff
        console.warn(`Попытка ${i + 1} не удалась (ConnectTimeoutError). Повтор через ${currentDelay} мс...`);
        await new Promise(resolve => setTimeout(resolve, currentDelay));
        continue;
      }
      throw err;
    }
  }
}

// Слэш-команды
const commands = [
  new SlashCommandBuilder().setName('admin-panel').setDescription('Открыть админ-панель (только для админов)'),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Очистить сообщения в чате')
    .addIntegerOption(option => 
      option.setName('amount')
        .setDescription('Количество сообщений для удаления (1-100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    ),
  new SlashCommandBuilder()
    .setName('verification')
    .setDescription('Настроить роль верификации и запустить процесс'),
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Создать розыгрыш')
    .addIntegerOption(option => option.setName('duration').setDescription('Длительность в минутах').setRequired(true))
    .addIntegerOption(option => option.setName('winners').setDescription('Количество победителей').setRequired(true))
    .addStringOption(option => option.setName('prize').setDescription('Приз').setRequired(true))
    .addStringOption(option => option.setName('conditions').setDescription('Условия участия (опционально)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('giveaway-reroll')
    .setDescription('Перевыбрать победителей последнего розыгрыша'),
];

// Функция для развертывания команд
async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await withRetry(() => rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(c => c.toJSON()) }), 5, 5000);
    console.log('Слэш-команды успешно зарегистрированы.');
  } catch (error) {
    console.error('Ошибка регистрации команд:', error);
  }
}

// Событие ready
client.once('ready', () => {
  console.log(`Бот залогинен как ${client.user.tag}`);
  deployCommands();
  scheduleGiveaways();
});

// Проверка админа
function isAdmin(member) {
  return member && member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// Доступ к админ-панели
function canAccessAdminPanel(userId, member) {
  return allowedAdminIDs.includes(userId) || isAdmin(member);
}

// Настройки гильдии
async function getGuildSettings(guildId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM guild_settings WHERE guild_id = ?`, [guildId], (err, row) => {
      if (err) {
        console.error('Ошибка получения настроек гильдии:', err);
        reject(err);
      }
      resolve(row || {});
    });
  });
}

// Планирование завершения розыгрышей
async function scheduleGiveaways() {
  try {
    db.all(`SELECT * FROM giveaways`, [], async (err, rows) => {
      if (err) {
        console.error('Ошибка получения розыгрышей:', err);
        return;
      }
      for (const row of rows) {
        const timeLeft = row.end_time - Date.now();
        if (timeLeft > 0) {
          setTimeout(() => endGiveaway(row), timeLeft);
        } else {
          endGiveaway(row);
        }
      }
    });
    setTimeout(scheduleGiveaways, 300000); // Проверять каждые 5 минут
  } catch (err) {
    console.error('Ошибка в scheduleGiveaways:', err);
  }
}

// Завершение розыгрыша
async function endGiveaway(row) {
  try {
    const channel = await withRetry(() => client.channels.fetch(row.channel_id).catch(() => null), 5, 5000);
    if (!channel) {
      console.error(`Канал ${row.channel_id} не найден для розыгрыша ${row.id}`);
      db.run(`DELETE FROM giveaways WHERE id = ?`, [row.id]);
      return;
    }
    const message = await withRetry(() => channel.messages.fetch(row.message_id).catch(() => null), 5, 5000);
    if (!message) {
      console.error(`Сообщение ${row.message_id} не найдено для розыгрыша ${row.id}`);
      db.run(`DELETE FROM giveaways WHERE id = ?`, [row.id]);
      return;
    }

    const participants = row.participants ? row.participants.split(',').filter(id => id) : [];
    const winnersCount = Math.min(row.winners, participants.length);
    const winners = participants.sort(() => 0.5 - Math.random()).slice(0, winnersCount).map(id => `<@${id}>`);

    const announcement = winners.length > 0
      ? `🎉 Розыгрыш окончен! Победители: ${winners.join(', ')} выиграли ${row.prize}!`
      : `🎉 Розыгрыш окончен! К сожалению, не было участников для ${row.prize}.`;
    
    await withRetry(() => channel.send({ content: announcement }), 5, 5000);
    db.run(`DELETE FROM giveaways WHERE id = ?`, [row.id], (err) => {
      if (err) console.error(`Ошибка удаления розыгрыша ${row.id}:`, err);
    });
  } catch (err) {
    console.error(`Ошибка обработки розыгрыша ${row.id}:`, err);
  }
}

// Обработка взаимодействий
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    if (interaction.isCommand()) {
      const { commandName } = interaction;

      if (commandName === 'admin-panel') {
        if (!canAccessAdminPanel(interaction.user.id, interaction.member)) {
          return await withRetry(() => interaction.reply({ content: 'Доступ только для администраторов.', ephemeral: true }), 5, 5000);
        }
        const embed = new EmbedBuilder()
          .setColor(colors.embed)
          .setTitle('Админ-Панель')
          .setDescription('Выберите категорию:')
          .setFooter({ text: 'Parameters Bot' });
        const row1 = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('anti-crash').setLabel('Анти-Краш').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('roles').setLabel('Роли').setStyle(ButtonStyle.Secondary)
          );
        await withRetry(() => interaction.reply({ embeds: [embed], components: [row1], ephemeral: true }), 5, 5000);
      } else if (commandName === 'clear') {
        const amount = interaction.options.getInteger('amount');
        if (amount < 1 || amount > 100) {
          return await withRetry(() => interaction.reply({ content: 'Количество должно быть от 1 до 100.', ephemeral: true }), 5, 5000);
        }
        try {
          const messages = await withRetry(() => interaction.channel.messages.fetch({ limit: amount }), 5, 5000);
          await withRetry(() => interaction.channel.bulkDelete(messages, true), 5, 5000);
          await withRetry(() => interaction.reply({ content: `Удалено ${amount} сообщений.`, ephemeral: true }), 5, 5000);
        } catch (err) {
          console.error('Ошибка очистки сообщений:', err);
          await withRetry(() => interaction.reply({ content: 'Ошибка при очистке сообщений. Убедитесь, что бот имеет права на управление сообщениями.', ephemeral: true }), 5, 5000);
        }
      } else if (commandName === 'verification') {
        if (!isAdmin(interaction.member)) {
          return await withRetry(() => interaction.reply({ content: 'Только администраторы могут настраивать верификацию.', ephemeral: true }), 5, 5000);
        }
        const embed = new EmbedBuilder()
          .setColor(colors.embed)
          .setTitle('Настройка верификации')
          .setDescription('Введите ID роли верификации.')
          .setFooter({ text: 'Parameters Bot' });
        await withRetry(() => interaction.reply({ embeds: [embed], ephemeral: true }), 5, 5000);

        const filter = m => m.author.id === interaction.user.id && m.channel.id === interaction.channel.id;
        const roleCollector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60000 });

        roleCollector.on('collect', async m => {
          try {
            const roleId = m.content.trim();
            if (!/^\d{17,19}$/.test(roleId)) {
              await withRetry(() => interaction.followUp({ content: 'Некорректный ID роли. Должно быть 17-19 цифр.', ephemeral: true }), 5, 5000);
              return;
            }
            const role = await withRetry(() => interaction.guild.roles.fetch(roleId).catch(() => null), 5, 5000);
            if (!role) {
              await withRetry(() => interaction.followUp({ content: 'Роль не найдена на сервере.', ephemeral: true }), 5, 5000);
              return;
            }
            if (role.position >= interaction.guild.members.me.roles.highest.position) {
              await withRetry(() => interaction.followUp({ content: 'Роль выше роли бота в иерархии. Выберите роль ниже.', ephemeral: true }), 5, 5000);
              return;
            }
            if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
              await withRetry(() => interaction.followUp({ content: 'У бота нет прав для управления ролями.', ephemeral: true }), 5, 5000);
              return;
            }
            db.run(`INSERT OR REPLACE INTO guild_settings (guild_id, verify_role_id) VALUES (?, ?)`, [interaction.guild.id, roleId], async (err) => {
              if (err) {
                console.error('Ошибка установки роли верификации:', err);
                await withRetry(() => interaction.followUp({ content: 'Ошибка при установке роли верификации.', ephemeral: true }), 5, 5000);
                return;
              }
              await withRetry(() => m.delete().catch(err => console.error('Ошибка удаления сообщения с ID роли:', err)), 5, 5000);
              const nameEmbed = new EmbedBuilder()
                .setColor(colors.embed)
                .setTitle('Настройка верификации')
                .setDescription('Введите название вашего сервера которое будет отображаться при верификации.')
                .setFooter({ text: 'Пример: Добро пожаловать на сервер `Название`!' });
              await withRetry(() => interaction.editReply({ embeds: [nameEmbed], components: [], ephemeral: true }), 5, 5000);
            });
            const nameCollector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60000 });

            nameCollector.on('collect', async mn => {
              try {
                const serverName = mn.content.trim() === 'default' ? null : mn.content.trim();
                if (!serverName && mn.content.trim() !== 'default') {
                  await withRetry(() => interaction.followUp({ content: 'Название не может быть пустым. Попробуйте снова.', ephemeral: true }), 5, 5000);
                  return;
                }
                db.run(`UPDATE guild_settings SET server_name = ? WHERE guild_id = ?`, [serverName, interaction.guild.id], async (err) => {
                  if (err) {
                    console.error('Ошибка установки названия сервера:', err);
                    await withRetry(() => interaction.followUp({ content: 'Ошибка при установке названия сервера.', ephemeral: true }), 5, 5000);
                    return;
                  }
                  await withRetry(() => mn.delete().catch(err => console.error('Ошибка удаления сообщения с названием сервера:', err)), 5, 5000);
                  await withRetry(() => interaction.editReply({ content: `Настройки верификации сохранены. Название сервера: ${serverName || 'Верификация'}.`, embeds: [], components: [], ephemeral: true }), 5, 5000);

                  // Получаем настройки
                  const settings = await getGuildSettings(interaction.guild.id);
                  // Отправляем фото отдельно
                  await withRetry(() => interaction.channel.send({ content: 'https://i.postimg.cc/prLwqfGS/download-2.jpg' }), 5, 5000);
                  // Отправляем embed с кнопкой верификации
                  const verificationEmbed = new EmbedBuilder()
                    .setColor(colors.embed)
                    .setTitle(`Добро пожаловать на сервер ${settings.server_name || 'Верификация'}!`)
                    .setDescription('Нажмите кнопку ниже для верификации, чтобы получить доступ к полному функционалу сервера.')
                    .setFooter({ text: 'Parameters Bot' });
                  const verifyButton = new ActionRowBuilder()
                    .addComponents(
                      new ButtonBuilder()
                        .setCustomId('verify')
                        .setLabel('Верификация')
                        .setEmoji('📎')
                        .setStyle(ButtonStyle.Secondary)
                    );
                  await withRetry(() => interaction.channel.send({ embeds: [verificationEmbed], components: [verifyButton] }), 5, 5000);
                });
              } catch (err) {
                console.error('Ошибка в nameCollector:', err);
                await withRetry(() => interaction.followUp({ content: 'Произошла ошибка при обработке названия сервера.', ephemeral: true }), 5, 5000);
              }
            });

            nameCollector.on('end', collected => {
              if (!collected.size) {
                withRetry(() => interaction.followUp({ content: 'Время для ввода названия сервера истекло.', ephemeral: true }), 5, 5000);
              }
            });
          } catch (err) {
            console.error('Ошибка в roleCollector:', err);
            await withRetry(() => interaction.followUp({ content: 'Произошла ошибка при обработке ID роли. Проверьте права бота и корректность ID.', ephemeral: true }), 5, 5000);
          }
        });

        roleCollector.on('end', collected => {
          if (!collected.size) {
            withRetry(() => interaction.editReply({ content: 'Время для ввода ID роли истекло. Используйте /verification снова.', embeds: [], components: [], ephemeral: true }), 5, 5000);
          }
        });
      } else if (commandName === 'giveaway') {
        if (!isAdmin(interaction.member)) {
          return await withRetry(() => interaction.reply({ content: 'Только администраторы могут создавать розыгрыши.', ephemeral: true }), 5, 5000);
        }
        const duration = interaction.options.getInteger('duration');
        const winners = interaction.options.getInteger('winners');
        const prize = interaction.options.getString('prize');
        const conditions = interaction.options.getString('conditions') || 'Нет условий';

        if (duration <= 0 || winners <= 0) {
          return await withRetry(() => interaction.reply({ content: 'Длительность и количество победителей должны быть больше 0.', ephemeral: true }), 5, 5000);
        }

        const endTime = Date.now() + duration * 60 * 1000;
        const embed = new EmbedBuilder()
          .setColor(colors.embed)
          .setTitle('🎉 Новый розыгрыш!')
          .setDescription(`**Приз:** ${prize}\n**Длительность:** ${duration} минут\n**Победителей:** ${winners}\n**Условия:** ${conditions}\n**Участников:** 0\nНажмите 🎉, чтобы участвовать!`)
          .setFooter({ text: `Окончание: ${new Date(endTime).toLocaleString()}` });

        await withRetry(() => interaction.reply({ embeds: [embed] }), 5, 5000);
        const msg = await withRetry(() => interaction.fetchReply().catch(err => { console.error('Ошибка получения сообщения розыгрыша:', err); return null; }), 5, 5000);
        if (!msg) {
          await withRetry(() => interaction.followUp({ content: 'Ошибка при создании розыгрыша: не удалось получить сообщение.', ephemeral: true }), 5, 5000);
          return;
        }
        await withRetry(() => msg.react('🎉').catch(err => {
          console.error('Ошибка добавления реакции:', err);
          interaction.followUp({ content: 'Ошибка при добавлении реакции к сообщению розыгрыша.', ephemeral: true });
        }), 5, 5000);

        db.run(`INSERT INTO giveaways (guild_id, channel_id, message_id, prize, duration, winners, conditions, end_time, participants) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
          [interaction.guild.id, interaction.channel.id, msg.id, prize, duration, winners, conditions, endTime, ''], (err) => {
            if (err) {
              console.error('Ошибка сохранения розыгрыша:', err);
              withRetry(() => interaction.followUp({ content: 'Ошибка при сохранении розыгрыша в базе данных.', ephemeral: true }), 5, 5000);
            } else {
              setTimeout(() => {
                db.get(`SELECT * FROM giveaways WHERE message_id = ?`, [msg.id], (err, row) => {
                  if (err || !row) {
                    console.error('Ошибка получения розыгрыша для завершения:', err);
                    return;
                  }
                  endGiveaway(row);
                });
              }, duration * 60 * 1000);
            }
          });
      } else if (commandName === 'giveaway-reroll') {
        if (!isAdmin(interaction.member)) {
          return await withRetry(() => interaction.reply({ content: 'Только администраторы могут перевыбирать победителей.', ephemeral: true }), 5, 5000);
        }
        db.get(`SELECT participants, winners, prize, channel_id FROM giveaways WHERE guild_id = ? ORDER BY end_time DESC LIMIT 1`, [interaction.guild.id], async (err, row) => {
          if (err || !row) {
            console.error('Ошибка получения последнего розыгрыша:', err);
            return await withRetry(() => interaction.reply({ content: 'Последний розыгрыш не найден.', ephemeral: true }), 5, 5000);
          }
          const participants = row.participants ? row.participants.split(',').filter(id => id) : [];
          const winnersCount = Math.min(row.winners, participants.length);
          const winners = participants.sort(() => 0.5 - Math.random()).slice(0, winnersCount).map(id => `<@${id}>`);

          const channel = await withRetry(() => client.channels.fetch(row.channel_id).catch(() => null), 5, 5000);
          if (!channel) {
            return await withRetry(() => interaction.reply({ content: 'Канал розыгрыша не найден.', ephemeral: true }), 5, 5000);
          }

          if (winners.length > 0) {
            await withRetry(() => channel.send({ content: `🎉 Новые победители: ${winners.join(', ')} выиграли ${row.prize}!` }), 5, 5000);
            await withRetry(() => interaction.reply({ content: `Перевыбраны победители: ${winners.join(', ')}.`, ephemeral: true }), 5, 5000);
          } else {
            await withRetry(() => interaction.reply({ content: '🎉 К сожалению, не осталось участников для перевыбора.', ephemeral: true }), 5, 5000);
          }
        });
      }
    } else if (interaction.isButton()) {
      const customId = interaction.customId;

      if (customId === 'back_to_main') {
        const embed = new EmbedBuilder()
          .setColor(colors.embed)
          .setTitle('Админ-Панель')
          .setDescription('Выберите категорию:')
          .setFooter({ text: 'Parameters Bot' });
        const row1 = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('anti-crash').setLabel('Анти-Краш').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('roles').setLabel('Роли').setStyle(ButtonStyle.Secondary)
          );
        await withRetry(() => interaction.update({ embeds: [embed], components: [row1], ephemeral: true }), 5, 5000);
      } else if (customId === 'anti-crash') {
        const embed = new EmbedBuilder()
          .setColor(colors.embed)
          .setTitle('Анти-Краш')
          .setDescription('Выберите действие:')
          .setFooter({ text: 'Parameters Bot' });
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('whitelist_add').setLabel('Добавить в whitelist').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('whitelist_remove').setLabel('Удалить из whitelist').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('blocked_add').setLabel('Добавить слова').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('blocked_remove').setLabel('Удалить слова').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('blocked_list').setLabel('Список слов').setStyle(ButtonStyle.Secondary)
          );
        const backRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('back_to_main').setLabel('Назад').setStyle(ButtonStyle.Danger)
          );
        await withRetry(() => interaction.update({ embeds: [embed], components: [row, backRow], ephemeral: true }), 5, 5000);
      } else if (customId === 'roles') {
        const embed = new EmbedBuilder()
          .setColor(colors.embed)
          .setTitle('Роли')
          .setDescription('Выберите действие:')
          .setFooter({ text: 'Parameters Bot' });
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('set_verify_role').setLabel('Роль верификации').setStyle(ButtonStyle.Secondary)
          );
        const backRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('back_to_main').setLabel('Назад').setStyle(ButtonStyle.Danger)
          );
        await withRetry(() => interaction.update({ embeds: [embed], components: [row, backRow], ephemeral: true }), 5, 5000);
      } else if (customId === 'whitelist_add') {
        await withRetry(() => interaction.reply({ content: 'Введите ID пользователя для whitelist:', ephemeral: true }), 5, 5000);
        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 30000 });
        collector.on('collect', async m => {
          try {
            const userId = m.content.trim();
            if (!/^\d{17,19}$/.test(userId)) {
              await withRetry(() => interaction.followUp({ content: 'Некорректный ID пользователя. Должно быть 17-19 цифр.', ephemeral: true }), 5, 5000);
              return;
            }
            const user = await withRetry(() => client.users.fetch(userId).catch(() => null), 5, 5000);
            if (!user) {
              await withRetry(() => interaction.followUp({ content: 'Пользователь не найден.', ephemeral: true }), 5, 5000);
              return;
            }
            db.run(`INSERT OR IGNORE INTO whitelist (user_id) VALUES (?)`, [userId], (err) => {
              if (err) {
                console.error('Ошибка добавления в whitelist:', err);
                withRetry(() => interaction.followUp({ content: 'Ошибка при добавлении.', ephemeral: true }), 5, 5000);
              } else {
                withRetry(() => interaction.followUp({ content: 'Пользователь добавлен в whitelist.', ephemeral: true }), 5, 5000);
              }
            });
            await withRetry(() => m.delete().catch(() => {}), 5, 5000);
          } catch (err) {
            console.error('Ошибка в whitelist_add collector:', err);
            await withRetry(() => interaction.followUp({ content: 'Произошла ошибка при обработке.', ephemeral: true }), 5, 5000);
          }
        });
        collector.on('end', collected => {
          if (!collected.size) withRetry(() => interaction.followUp({ content: 'Время ввода истекло.', ephemeral: true }), 5, 5000);
        });
      } else if (customId === 'whitelist_remove') {
        await withRetry(() => interaction.reply({ content: 'Введите ID пользователя для удаления из whitelist:', ephemeral: true }), 5, 5000);
        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 30000 });
        collector.on('collect', async m => {
          try {
            const userId = m.content.trim();
            if (!/^\d{17,19}$/.test(userId)) {
              await withRetry(() => interaction.followUp({ content: 'Некорректный ID пользователя. Должно быть 17-19 цифр.', ephemeral: true }), 5, 5000);
              return;
            }
            db.run(`DELETE FROM whitelist WHERE user_id = ?`, [userId], (err) => {
              if (err) {
                console.error('Ошибка удаления из whitelist:', err);
                withRetry(() => interaction.followUp({ content: 'Ошибка при удалении.', ephemeral: true }), 5, 5000);
              } else {
                withRetry(() => interaction.followUp({ content: 'Пользователь удалён из whitelist.', ephemeral: true }), 5, 5000);
              }
            });
            await withRetry(() => m.delete().catch(() => {}), 5, 5000);
          } catch (err) {
            console.error('Ошибка в whitelist_remove collector:', err);
            await withRetry(() => interaction.followUp({ content: 'Произошла ошибка при обработке.', ephemeral: true }), 5, 5000);
          }
        });
        collector.on('end', collected => {
          if (!collected.size) withRetry(() => interaction.followUp({ content: 'Время ввода истекло.', ephemeral: true }), 5, 5000);
        });
      } else if (customId === 'blocked_add') {
        await withRetry(() => interaction.reply({ content: 'Введите слова для блокировки через запятую (например: слово1, слово2, слово3):', ephemeral: true }), 5, 5000);
        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 30000 });
        collector.on('collect', async m => {
          try {
            const words = m.content.toLowerCase().split(',').map(w => w.trim()).filter(w => w !== '');
            if (words.length === 0) {
              await withRetry(() => interaction.followUp({ content: 'Не указано ни одного слова.', ephemeral: true }), 5, 5000);
              return;
            }
            let addedWords = [];
            words.forEach(word => {
              db.run(`INSERT OR IGNORE INTO blocked_words (word) VALUES (?)`, [word], (err) => {
                if (err) {
                  console.error(`Ошибка добавления слова "${word}":`, err);
                } else {
                  addedWords.push(word);
                }
              });
            });
            await withRetry(() => interaction.followUp({ content: `Добавлены слова: ${addedWords.join(', ') || 'Ни одно (возможно, уже существуют)'}.`, ephemeral: true }), 5, 5000);
            await withRetry(() => m.delete().catch(() => {}), 5, 5000);
          } catch (err) {
            console.error('Ошибка в blocked_add collector:', err);
            await withRetry(() => interaction.followUp({ content: 'Произошла ошибка при обработке.', ephemeral: true }), 5, 5000);
          }
        });
        collector.on('end', collected => {
          if (!collected.size) withRetry(() => interaction.followUp({ content: 'Время ввода истекло.', ephemeral: true }), 5, 5000);
        });
      } else if (customId === 'blocked_remove') {
        await withRetry(() => interaction.reply({ content: 'Введите слова для удаления через запятую (например: слово1, слово2, слово3):', ephemeral: true }), 5, 5000);
        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 30000 });
        collector.on('collect', async m => {
          try {
            const words = m.content.toLowerCase().split(',').map(w => w.trim()).filter(w => w !== '');
            if (words.length === 0) {
              await withRetry(() => interaction.followUp({ content: 'Не указано ни одного слова.', ephemeral: true }), 5, 5000);
              return;
            }
            let removedWords = [];
            words.forEach(word => {
              db.run(`DELETE FROM blocked_words WHERE word = ?`, [word], (err) => {
                if (err) {
                  console.error(`Ошибка удаления слова "${word}":`, err);
                } else {
                  removedWords.push(word);
                }
              });
            });
            await withRetry(() => interaction.followUp({ content: `Удалены слова: ${removedWords.join(', ') || 'Ни одно (возможно, не существуют)'}.`, ephemeral: true }), 5, 5000);
            await withRetry(() => m.delete().catch(() => {}), 5, 5000);
          } catch (err) {
            console.error('Ошибка в blocked_remove collector:', err);
            await withRetry(() => interaction.followUp({ content: 'Произошла ошибка при обработке.', ephemeral: true }), 5, 5000);
          }
        });
        collector.on('end', collected => {
          if (!collected.size) withRetry(() => interaction.followUp({ content: 'Время ввода истекло.', ephemeral: true }), 5, 5000);
        });
      } else if (customId === 'blocked_list') {
        db.all(`SELECT * FROM blocked_words`, [], (err, rows) => {
          if (err) {
            console.error('Ошибка получения списка слов:', err);
            return withRetry(() => interaction.reply({ content: 'Ошибка получения списка.', ephemeral: true }), 5, 5000);
          }
          const list = rows.map(r => r.word).join(', ') || 'Список пуст';
          withRetry(() => interaction.reply({ content: `Заблокированные слова: ${list}`, ephemeral: true }), 5, 5000);
        });
      } else if (customId === 'set_verify_role') {
        await withRetry(() => interaction.reply({ content: 'Введите ID роли верификации:', ephemeral: true }), 5, 5000);
        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 30000 });
        collector.on('collect', async m => {
          try {
            const roleId = m.content.trim();
            if (!/^\d{17,19}$/.test(roleId)) {
              await withRetry(() => interaction.followUp({ content: 'Некорректный ID роли. Должно быть 17-19 цифр.', ephemeral: true }), 5, 5000);
              return;
            }
            const role = await withRetry(() => interaction.guild.roles.fetch(roleId).catch(() => null), 5, 5000);
            if (!role) {
              await withRetry(() => interaction.followUp({ content: 'Роль не найдена на сервере.', ephemeral: true }), 5, 5000);
              return;
            }
            if (role.position >= interaction.guild.members.me.roles.highest.position) {
              await withRetry(() => interaction.followUp({ content: 'Роль выше роли бота в иерархии. Выберите роль ниже.', ephemeral: true }), 5, 5000);
              return;
            }
            if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
              await withRetry(() => interaction.followUp({ content: 'У бота нет прав для управления ролями.', ephemeral: true }), 5, 5000);
              return;
            }
            db.run(`INSERT OR REPLACE INTO guild_settings (guild_id, verify_role_id) VALUES (?, ?)`, [interaction.guild.id, roleId], (err) => {
              if (err) {
                console.error('Ошибка установки роли верификации:', err);
                withRetry(() => interaction.followUp({ content: 'Ошибка при установке роли верификации.', ephemeral: true }), 5, 5000);
              } else {
                withRetry(() => interaction.followUp({ content: 'Роль верификации успешно установлена.', ephemeral: true }), 5, 5000);
              }
            });
            await withRetry(() => m.delete().catch(err => console.error('Ошибка удаления сообщения:', err)), 5, 5000);
          } catch (err) {
            console.error('Ошибка в set_verify_role collector:', err);
            await withRetry(() => interaction.followUp({ content: 'Произошла ошибка при обработке.', ephemeral: true }), 5, 5000);
          }
        });
        collector.on('end', collected => {
          if (!collected.size) withRetry(() => interaction.followUp({ content: 'Время ввода истекло.', ephemeral: true }), 5, 5000);
        });
      } else if (customId === 'verify') {
        const settings = await getGuildSettings(interaction.guild.id).catch(() => null);
        const verifyRoleId = settings?.verify_role_id;
        if (!verifyRoleId) {
          await withRetry(() => interaction.reply({ content: 'Роль верификации не настроена. Настройте в /admin-panel.', ephemeral: true }), 5, 5000);
          return;
        }
        const verifyRole = interaction.guild.roles.cache.get(verifyRoleId);
        if (!verifyRole) {
          await withRetry(() => interaction.reply({ content: 'Роль верификации не найдена на сервере.', ephemeral: true }), 5, 5000);
          return;
        }
        const member = interaction.member;
        if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          await withRetry(() => interaction.reply({ content: 'У бота нет прав для управления ролями.', ephemeral: true }), 5, 5000);
          return;
        }
        if (verifyRole.position >= interaction.guild.members.me.roles.highest.position) {
          await withRetry(() => interaction.reply({ content: 'Роль верификации выше роли бота в иерархии.', ephemeral: true }), 5, 5000);
          return;
        }
        if (member.roles.cache.has(verifyRoleId)) {
          await withRetry(() => interaction.reply({ content: 'Вы уже верифицированы!', ephemeral: true }), 5, 5000);
          return;
        }
        await withRetry(() => member.roles.add(verifyRole).catch(err => {
          console.error('Ошибка добавления роли верификации:', err);
          interaction.reply({ content: 'Ошибка при добавлении роли верификации.', ephemeral: true });
        }), 5, 5000);
        await withRetry(() => interaction.reply({ content: 'Вы успешно верифицированы!', ephemeral: true }), 5, 5000);
      }
    }
  } catch (err) {
    console.error('Ошибка в interactionCreate:', err);
    if (!interaction.replied && !interaction.deferred) {
      await withRetry(() => interaction.reply({ content: 'Произошла ошибка при обработке команды.', ephemeral: true }).catch(() => {}), 5, 5000);
    }
  }
});

// Обработка реакций для розыгрышей
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot || !reaction.message.guild) return;
    if (reaction.emoji.name !== '🎉') return;

    const message = reaction.message;
    db.get(`SELECT * FROM giveaways WHERE message_id = ? AND channel_id = ?`, [message.id, message.channel.id], async (err, row) => {
      if (err) {
        console.error('Ошибка получения розыгрыша:', err);
        return;
      }
      if (!row) {
        console.error(`Розыгрыш для сообщения ${message.id} не найден`);
        return;
      }
      let participants = row.participants ? row.participants.split(',').filter(id => id) : [];
      if (!participants.includes(user.id)) {
        participants.push(user.id);
        db.run(`UPDATE giveaways SET participants = ? WHERE message_id = ?`, [participants.join(','), message.id], async (updateErr) => {
          if (updateErr) {
            console.error('Ошибка обновления участников:', updateErr);
            return;
          }
          try {
            const embed = EmbedBuilder.from(message.embeds[0]).setDescription(
              `**Приз:** ${row.prize}\n**Длительность:** ${row.duration} минут\n**Победителей:** ${row.winners}\n**Условия:** ${row.conditions}\n**Участников:** ${participants.length}\nНажмите 🎉, чтобы участвовать!`
            );
            await withRetry(() => message.edit({ embeds: [embed] }), 5, 5000);
          } catch (err) {
            console.error('Ошибка обновления сообщения розыгрыша:', err);
          }
        });
      }
    });
  } catch (err) {
    console.error('Ошибка в messageReactionAdd:', err);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot || !reaction.message.guild) return;
    if (reaction.emoji.name !== '🎉') return;

    const message = reaction.message;
    db.get(`SELECT * FROM giveaways WHERE message_id = ? AND channel_id = ?`, [message.id, message.channel.id], async (err, row) => {
      if (err) {
        console.error('Ошибка получения розыгрыша:', err);
        return;
      }
      if (!row) {
        console.error(`Розыгрыш для сообщения ${message.id} не найден`);
        return;
      }
      let participants = row.participants ? row.participants.split(',').filter(id => id) : [];
      if (participants.includes(user.id)) {
        participants = participants.filter(id => id !== user.id);
        db.run(`UPDATE giveaways SET participants = ? WHERE message_id = ?`, [participants.join(','), message.id], async (updateErr) => {
          if (updateErr) {
            console.error('Ошибка обновления участников:', updateErr);
            return;
          }
          try {
            const embed = EmbedBuilder.from(message.embeds[0]).setDescription(
              `**Приз:** ${row.prize}\n**Длительность:** ${row.duration} минут\n**Победителей:** ${row.winners}\n**Условия:** ${row.conditions}\n**Участников:** ${participants.length}\nНажмите 🎉, чтобы участвовать!`
            );
            await withRetry(() => message.edit({ embeds: [embed] }), 5, 5000);
          } catch (err) {
            console.error('Ошибка обновления сообщения розыгрыша:', err);
          }
        });
      }
    });
  } catch (err) {
    console.error('Ошибка в messageReactionRemove:', err);
  }
});

// Анти-краш (сообщения)
client.on('messageCreate', async message => {
  try {
    if (message.author.bot || !message.guild) return;

    db.get(`SELECT * FROM whitelist WHERE user_id = ?`, [message.author.id], async (err, row) => {
      if (err) {
        console.error('Ошибка проверки whitelist:', err);
        return;
      }
      if (row) return;

      const contentLower = message.content.toLowerCase();
      // Проверка на запрещённые паттерны: "# " или "## " (с пробелом после)
      const forbiddenPatterns = [/# /, /## /, /-# /];
      if (forbiddenPatterns.some(pattern => pattern.test(message.content))) {
        const member = message.member;
        if (member && member.moderatable) {
          await withRetry(() => member.timeout(24 * 60 * 60 * 1000, 'Использование запрещённых символов').catch(err => console.error('Ошибка тайм-аута за символы:', err)), 5, 5000);
        }
        await withRetry(() => message.delete().catch(err => console.error('Ошибка удаления сообщения:', err)), 5, 5000);
        return;
      }

      db.all(`SELECT * FROM blocked_words`, [], async (err, rows) => {
        if (err) {
          console.error('Ошибка получения заблокированных слов:', err);
          return;
        }
        const blocked = rows.map(r => r.word);
        if (blocked.some(word => contentLower.includes(word))) {
          const member = message.member;
          if (member && member.moderatable) {
            await withRetry(() => member.timeout(24 * 60 * 60 * 1000, 'Использование заблокированных слов').catch(err => console.error('Ошибка тайм-аута за слова:', err)), 5, 5000);
          }
          await withRetry(() => message.delete().catch(err => console.error('Ошибка удаления сообщения:', err)), 5, 5000);
        }
      });
    });
  } catch (err) {
    console.error('Ошибка в messageCreate:', err);
  }
});

// Глобальная обработка ошибок
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Логин с обработкой ошибок
async function loginWithRetry() {
  const maxRetries = 5;
  const baseDelay = 5000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`Попытка логина ${i + 1}...`);
      await client.login(process.env.BOT_TOKEN);
      console.log('Логин успешен.');
      return;
    } catch (err) {
      const currentDelay = baseDelay * Math.pow(2, i); // Экспоненциальный backoff
      if (err.code === 'UND_ERR_CONNECT_TIMEOUT' && i < maxRetries - 1) {
        console.warn(`Попытка логина ${i + 1} не удалась (ConnectTimeoutError). Повтор через ${currentDelay} мс...`);
        await new Promise(resolve => setTimeout(resolve, currentDelay));
        continue;
      }
      console.error('Не удалось войти в систему после всех попыток:', err);
      process.exit(1);
    }
  }
}

// Запуск бота
loginWithRetry();