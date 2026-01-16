import * as crypto from "crypto";

export interface Contact {
  ip: string;
  port?: number;
  username: string;
}

export interface MessageMeta {
  contacts: Contact[];
  message: string;
  files: string[];
}

export interface PackedMessageMeta {
  id: string;
  count: number;
  last: number;
  check: number;
}

export interface PackedMessageTarget {
  ip: string;
  port: number;
}

export interface PackedMessage {
  mid: string;
  pid: number;
  content: Uint8Array;
  target: PackedMessageTarget;
}

export class ChatMessageProcessor {
  private readonly maxChunkSize: number;

  constructor(maxChunkSize: number = 1024) {
    this.maxChunkSize = maxChunkSize > 0 ? maxChunkSize : 1024;
  }

  // 解析文本中的 @联系人 和 #文件 标签，并返回规范化后的消息元数据
  public process(message: string, allContacts?: Contact[]): MessageMeta {
    const mentionedNames = this.extractMentionedNames(message);
    const filesSet = this.extractFiles(message);

    let matchedContacts: Contact[] = [];
    if (allContacts && allContacts.length > 0 && mentionedNames.size > 0) {
      const nameSet = new Set(mentionedNames);
      matchedContacts = allContacts.filter((c) => nameSet.has(c.username));
    }

    const contactNames =
      matchedContacts.length > 0
        ? new Set(matchedContacts.map((c) => c.username))
        : new Set<string>();
    const cleaned = this.cleanMessage(message, contactNames);

    return {
      contacts: matchedContacts,
      message: cleaned,
      files: Array.from(filesSet),
    };
  }

  // 计算消息整体分包信息（仅根据原始字符串）
  public prepare(message: string): PackedMessageMeta {
    const buffer = Buffer.from(message, "utf8");
    const length = buffer.length;
    const count =
      length === 0 ? 0 : Math.ceil(length / this.maxChunkSize);
    const last =
      length === 0
        ? 0
        : length % this.maxChunkSize || this.maxChunkSize;
    let check = 0;
    for (let i = 0; i < length; i++) {
      check = (check + buffer[i]) >>> 0;
    }
    const id = crypto.randomUUID();
    return {
      id,
      count,
      last,
      check,
    };
  }

  // 根据 MessageMeta 生成实际待发送的数据分包
  public subcontract(mm: MessageMeta): PackedMessage[] {
    const meta = this.prepare(mm.message);
    const buffer = Buffer.from(mm.message, "utf8");
    const chunks: Uint8Array[] = [];
    if (buffer.length === 0) {
      chunks.push(new Uint8Array(0));
    } else {
      for (let offset = 0; offset < buffer.length; offset += this.maxChunkSize) {
        const end = Math.min(offset + this.maxChunkSize, buffer.length);
        chunks.push(buffer.subarray(offset, end));
      }
    }

    const result: PackedMessage[] = [];
    for (const contact of mm.contacts) {
      const ip = contact.ip || "";
      let port = 0;
      if (
        typeof contact.port === "number" &&
        contact.port > 0 &&
        contact.port <= 65535
      ) {
        port = contact.port;
      }
      for (let i = 0; i < chunks.length; i++) {
        result.push({
          mid: meta.id,
          pid: i,
          content: chunks[i],
          target: {
            ip,
            port,
          },
        });
      }
    }
    return result;
  }

  private extractMentionedNames(message: string): Set<string> {
    const result = new Set<string>();
    const contactRegex = /@([^\s@#]+)/g;
    let match: RegExpExecArray | null;
    while ((match = contactRegex.exec(message)) !== null) {
      const name = match[1].replace(/[.,;:!?]+$/, "");
      if (name) {
        result.add(name);
      }
    }
    return result;
  }

  private extractFiles(message: string): Set<string> {
    const filesSet = new Set<string>();
    const fileRegex = /#([^\s#]+)/g;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(message)) !== null) {
      const filePath = match[1];
      if (filePath) {
        filesSet.add(filePath);
      }
    }
    return filesSet;
  }

  private cleanMessage(message: string, validContactNames: Set<string>): string {
    return message
      .replace(/@([^\s@#]+)/g, (m, name) => {
        const cleanedName = String(name).replace(/[.,;:!?]+$/, "");
        return validContactNames.has(cleanedName) ? "" : m;
      })
      .replace(/#([^\s#]+)/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
}
