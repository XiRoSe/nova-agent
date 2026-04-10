import fs from 'fs';
import path from 'path';

import { Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, STORE_DIR, TRIGGER_PATTERN } from '../config.js';
import { storeMessage } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  // Track active thread per chat: chatId → message_id to reply to
  private activeThread = new Map<string, number>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Determine thread context.
      // Use message_thread_id for forum topics, or the message_id for
      // regular chats (bot will reply to this message to form a chain).
      const forumThreadId = ctx.message.message_thread_id;
      const threadId = forumThreadId
        ? String(forumThreadId)
        : String(ctx.message.message_id);

      // Track so sendMessage can reply to this message
      this.activeThread.set(String(ctx.chat.id), ctx.message.message_id);

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

      // Download the largest photo size
      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const res = await fetch(fileUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const imgId = `tg-${Date.now()}`;
          const ext = file.file_path?.endsWith('.png') ? '.png' : '.jpg';
          const mediaDir = path.join(STORE_DIR, 'media');
          fs.mkdirSync(mediaDir, { recursive: true });
          fs.writeFileSync(path.join(mediaDir, `${imgId}${ext}`), buf);

          this.opts.onMessage(chatJid, {
            id: ctx.message.message_id.toString(),
            chat_jid: chatJid,
            sender: ctx.from?.id?.toString() || '',
            sender_name: senderName,
            content: `[image:${imgId}${ext}]${caption}`,
            timestamp,
            is_from_me: false,
          });
          logger.info({ chatJid, imgId }, 'Telegram photo downloaded + stored');
          return;
        }
      } catch (err) {
        logger.warn({ chatJid, err }, 'Failed to download Telegram photo, using placeholder');
      }
      // Fallback to placeholder
      storeNonText(ctx, '[Photo]');
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const replyTo = this.activeThread.get(numericId);

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      const replyParams = replyTo
        ? { reply_parameters: { message_id: replyTo } }
        : {};
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text, replyParams);
      } else {
        // Only reply to the first chunk; subsequent chunks are standalone
        await this.bot.api.sendMessage(
          numericId,
          text.slice(0, MAX_LENGTH),
          replyParams,
        );
        for (let i = MAX_LENGTH; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info(
        { jid, length: text.length, replyTo },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendImage(jid: string, imageBase64: string, mimeType: string, caption?: string): Promise<void> {
    if (!this.bot) {
      logger.warn({ jid }, 'Telegram bot not initialized, image not sent');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      const imgBuffer = Buffer.from(imageBase64, 'base64');
      const replyTo = this.activeThread.get(numericId);
      const replyParams = replyTo
        ? { reply_parameters: { message_id: replyTo } }
        : {};

      await this.bot.api.sendPhoto(
        numericId,
        new InputFile(imgBuffer, 'image.jpg'),
        { caption: caption || '', ...replyParams },
      );

      // Save copy for web chat history
      const imgId = `sent-${Date.now()}`;
      const ext = mimeType.includes('png') ? '.png' : '.jpg';
      const mediaDir = path.join(STORE_DIR, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      fs.writeFileSync(path.join(mediaDir, `${imgId}${ext}`), imgBuffer);
      storeMessage({
        id: `img-${imgId}`,
        chat_jid: jid,
        sender: ASSISTANT_NAME,
        sender_name: ASSISTANT_NAME,
        content: `[image:${imgId}${ext}]${caption ? ' ' + caption : ''}`,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
      logger.info({ jid, imgId }, 'Telegram image sent + saved');
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send Telegram image');
    }
  }

  async sendImageUrl(jid: string, imageUrl: string, caption?: string): Promise<void> {
    if (!this.bot) {
      logger.warn({ jid }, 'Telegram bot not initialized, image URL not sent');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      const replyTo = this.activeThread.get(numericId);
      const replyParams = replyTo
        ? { reply_parameters: { message_id: replyTo } }
        : {};

      // Telegram can accept a URL directly for sendPhoto
      await this.bot.api.sendPhoto(numericId, imageUrl, {
        caption: caption || '',
        ...replyParams,
      });

      // Save copy for web chat history
      try {
        const imgId = `sent-${Date.now()}`;
        const mediaDir = path.join(STORE_DIR, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        const res = await fetch(imageUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const ext = imageUrl.includes('.png') ? '.png' : '.jpg';
          fs.writeFileSync(path.join(mediaDir, `${imgId}${ext}`), buf);
          storeMessage({
            id: `img-${imgId}`,
            chat_jid: jid,
            sender: ASSISTANT_NAME,
            sender_name: ASSISTANT_NAME,
            content: `[image:${imgId}${ext}]${caption ? ' ' + caption : ''}`,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
          });
        }
      } catch {
        // Image saved to Telegram but not to local store — not critical
      }
      logger.info({ jid }, 'Telegram image URL sent');
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send Telegram image URL');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
