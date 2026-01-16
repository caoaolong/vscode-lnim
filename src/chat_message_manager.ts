import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export type ChatMessageDirection = "incoming" | "outgoing";

export interface ChatMessageRecord {
  id: number;
  direction: ChatMessageDirection;
  peerKey: string;
  peerUsername: string;
  peerIp: string;
  peerPort: number | null;
  content: string;
  createdAt: number;
}

export interface ChatContact {
  ip: string;
  port?: number;
  username: string;
}

export class ChatMessageManager {
  private readonly dbFilePath: string;

  constructor(dbDirPath: string) {
    if (!fs.existsSync(dbDirPath)) {
      fs.mkdirSync(dbDirPath, { recursive: true });
    }
    this.dbFilePath = path.join(dbDirPath, "chat_messages.ndjson");
  }

  private appendRecord(record: ChatMessageRecord): void {
    const line = JSON.stringify(record) + "\n";
    try {
      fs.appendFileSync(this.dbFilePath, line, "utf8");
    } catch (e) {
      console.error("Failed to append chat message:", e);
    }
  }

  public async saveIncoming(
    from: { nickname?: string; ip?: string; port?: number },
    content: string,
    timestamp: number
  ): Promise<void> {
    const peerIp = from.ip || "";
    const peerPort = typeof from.port === "number" ? from.port : null;
    const peerUsername = from.nickname || "";
    const peerKey = `${peerIp}|${peerPort ?? ""}|${peerUsername}`;

    const record: ChatMessageRecord = {
      id: Date.now() + Math.floor(Math.random() * 1000), // Generate a unique-ish ID
      direction: "incoming",
      peerKey,
      peerUsername,
      peerIp,
      peerPort,
      content,
      createdAt: timestamp,
    };

    this.appendRecord(record);
  }

  public async saveOutgoing(
    to: ChatContact,
    content: string,
    timestamp: number,
    defaultPort: number
  ): Promise<void> {
    const peerIp = to.ip || "";
    const peerPort =
      to.port && to.port > 0 && to.port <= 65535 ? to.port : defaultPort;
    const peerUsername = to.username || "";
    const peerKey = `${peerIp}|${peerPort ?? ""}|${peerUsername}`;

    const record: ChatMessageRecord = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      direction: "outgoing",
      peerKey,
      peerUsername,
      peerIp,
      peerPort,
      content,
      createdAt: timestamp,
    };

    this.appendRecord(record);
  }

  public async getHistory(
    peerKey: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<ChatMessageRecord[]> {
    if (!fs.existsSync(this.dbFilePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.dbFilePath, "utf8");
      const lines = content.split("\n");
      const records: ChatMessageRecord[] = [];

      // Iterate backwards to find recent messages first?
      // Or just parse all, filter, and sort.
      // Given it's a file, parsing all is safer to ensure valid JSON.
      // Optimization: Process line by line.

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const record = JSON.parse(line) as ChatMessageRecord;
          if (record.peerKey === peerKey) {
            records.push(record);
          }
        } catch (e) {
          // Ignore malformed lines
        }
      }

      // Sort by createdAt DESC
      records.sort((a, b) => b.createdAt - a.createdAt);

      return records.slice(offset, offset + limit);
    } catch (e) {
      console.error("Failed to read chat history:", e);
      return [];
    }
  }

  public async close(): Promise<void> {
    // No explicit connection to close for NDJSON file append
  }
}
