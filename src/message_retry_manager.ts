import * as dgram from "dgram";
import { ChatMessage } from "./chat_message_service";

interface PendingMessage {
  message: ChatMessage;
  targetIp: string;
  targetPort: number;
  timer: NodeJS.Timeout;
  retryCount: number;
}

/**
 * 消息重试管理器
 * 管理所有等待回复的消息，自动重试未收到回复的消息
 */
export class MessageRetryManager {
  private pendingMessages = new Map<string, PendingMessage>();
  private readonly retryInterval: number;
  private readonly maxRetries: number;

  constructor(
    private readonly udpServer: dgram.Socket,
    retryInterval: number = 5000,
    maxRetries: number = -1
  ) {
    this.retryInterval = retryInterval;
    this.maxRetries = maxRetries;
  }

  /**
   * 生成 UUID
   */
  private generateUUID(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * 发送需要确认的消息
   * @param message 消息对象
   * @param targetIp 目标IP
   * @param targetPort 目标端口
   * @returns 消息ID
   */
  public sendWithRetry(
    message: Omit<ChatMessage, "id" | "reply">,
    targetIp: string,
    targetPort: number
  ): string {
    const messageId = this.generateUUID();
    
    const fullMessage: ChatMessage = {
      ...message,
      id: messageId,
      reply: false,
    };

    // 验证 request 和 reply 的互斥性
    if (fullMessage.request === false && fullMessage.reply === false) {
      console.error("错误：request 和 reply 不能同时为 false");
			return "";
    }

    this.sendMessage(fullMessage, targetIp, targetPort);

    // 设置重试定时器
    const timer = setTimeout(() => {
      this.retryMessage(messageId);
    }, this.retryInterval);

    this.pendingMessages.set(messageId, {
      message: fullMessage,
      targetIp,
      targetPort,
      timer,
      retryCount: 0,
    });

    return messageId;
  }

  /**
   * 发送回复消息（不需要重试）
   * @param originalMessageId 原始消息ID
   * @param message 消息对象
   * @param targetIp 目标IP
   * @param targetPort 目标端口
   */
  public sendReply(
    originalMessageId: string,
    message: Omit<ChatMessage, "id" | "reply">,
    targetIp: string,
    targetPort: number
  ): void {
    const replyMessage: ChatMessage = {
      ...message,
      id: originalMessageId,
      reply: true,
    };

    // 验证 request 和 reply 的互斥性
    if (replyMessage.request === true && replyMessage.reply === true) {
      console.error("错误：request 和 reply 不能同时为 true");
    }

    this.sendMessage(replyMessage, targetIp, targetPort);
  }

  /**
   * 标记消息已收到回复
   * @param messageId 消息ID
   */
  public markAsReceived(messageId: string): boolean {
    const pending = this.pendingMessages.get(messageId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingMessages.delete(messageId);
      return true;
    }
    return false;
  }

  /**
   * 重试发送消息
   */
  private retryMessage(messageId: string): void {
    const pending = this.pendingMessages.get(messageId);
    if (!pending) {
      return;
    }

    // 检查是否达到最大重试次数
    if (this.maxRetries > 0 && pending.retryCount >= this.maxRetries) {
      console.log(`消息 ${messageId} 达到最大重试次数，放弃重试`);
      this.pendingMessages.delete(messageId);
      return;
    }

    // 重新发送消息
    pending.retryCount++;
    console.log(
      `重试发送消息 ${messageId} (第 ${pending.retryCount} 次) 到 ${pending.targetIp}:${pending.targetPort}`
    );
    this.sendMessage(pending.message, pending.targetIp, pending.targetPort);

    // 重新设置定时器
    pending.timer = setTimeout(() => {
      this.retryMessage(messageId);
    }, this.retryInterval);
  }

  /**
   * 实际发送消息的方法
   */
  private sendMessage(
    message: ChatMessage,
    targetIp: string,
    targetPort: number
  ): void {
    const buf = Buffer.from(JSON.stringify(message), "utf8");
    this.udpServer.send(buf, targetPort, targetIp, (err) => {
      if (err) {
        console.error(
          `发送消息到 ${targetIp}:${targetPort} 失败:`,
          err
        );
      }
    });
  }

  /**
   * 取消指定消息的重试
   * @param messageId 消息ID
   */
  public cancelRetry(messageId: string): boolean {
    return this.markAsReceived(messageId);
  }

  /**
   * 获取待确认消息数量
   */
  public getPendingCount(): number {
    return this.pendingMessages.size;
  }

  /**
   * 清理所有待确认消息
   */
  public clearAll(): void {
    this.pendingMessages.forEach((pending) => {
      clearTimeout(pending.timer);
    });
    this.pendingMessages.clear();
  }

  /**
   * 销毁管理器
   */
  public dispose(): void {
    this.clearAll();
  }
}

