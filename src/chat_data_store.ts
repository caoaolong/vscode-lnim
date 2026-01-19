import * as vscode from "vscode";

export interface StoredUserSettings {
  nickname: string;
  ip: string;
  port: number;
}

export interface StoredContact {
  ip: string;
  port?: number;
  username: string;
  status?: boolean;
}

export type StoredChatDirection = "incoming" | "outgoing";

export interface StoredChatMessage {
  id: number;
  direction: StoredChatDirection;
  type: "chat" | "file" | "link";
  from: string;
  timestamp: number;
  value?: string;
  target?: string[];
  files?: string[];
}

export class ChatDataStore {
  private static readonly DEFAULT_PORT = 18080;

  private userSettings: StoredUserSettings;
  private contacts: StoredContact[];
  private chatMessages: StoredChatMessage[];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.userSettings = this.context.globalState.get<StoredUserSettings>(
      "userSettings",
      {
        nickname: "User",
        ip: "",
        port: ChatDataStore.DEFAULT_PORT,
      }
    );
    if (
      !this.userSettings.port ||
      this.userSettings.port <= 0 ||
      this.userSettings.port > 65535
    ) {
      this.userSettings.port = ChatDataStore.DEFAULT_PORT;
    }
    this.contacts = this.context.globalState.get<StoredContact[]>("contacts", []);
    this.chatMessages = this.context.globalState.get<StoredChatMessage[]>(
      "chatMessages",
      [],
    );
  }

  public getUserSettings(): StoredUserSettings {
    return this.userSettings;
  }

  public getContacts(): StoredContact[] {
    return this.contacts;
  }

  public async updateUserSettings(
    incoming: StoredUserSettings
  ): Promise<StoredUserSettings> {
    let port = incoming.port;
    if (!port || port <= 0 || port > 65535) {
      port = ChatDataStore.DEFAULT_PORT;
    }
    this.userSettings = {
      nickname: incoming.nickname || "User",
      ip: incoming.ip || "",
      port,
    };
    await this.context.globalState.update("userSettings", this.userSettings);
    return this.userSettings;
  }

  public async addContact(c: StoredContact): Promise<StoredContact[]> {
    if (c?.ip && c?.username) {
      const exists = this.contacts.some(
        (x) =>
          x.ip === c.ip &&
          (x.port || ChatDataStore.DEFAULT_PORT) ===
            (c.port || ChatDataStore.DEFAULT_PORT) &&
          x.username === c.username
      );
      if (!exists) {
        // 新添加的联系人 status 默认为 false
        const newContact: StoredContact = {
          ...c,
          status: false,
        };
        this.contacts.push(newContact);
        await this.context.globalState.update("contacts", this.contacts);
      }
    }
    return this.contacts;
  }

  public async updateContactStatus(
    ip: string,
    port: number | undefined,
    status: boolean
  ): Promise<StoredContact[]> {
    const targetPort = port || ChatDataStore.DEFAULT_PORT;
    const contact = this.contacts.find(
      (c) =>
        c.ip === ip &&
        (c.port || ChatDataStore.DEFAULT_PORT) === targetPort
    );
    if (contact) {
      contact.status = status;
      await this.context.globalState.update("contacts", this.contacts);
    }
    return this.contacts;
  }

  public async resetAllContactsStatus(): Promise<StoredContact[]> {
    this.contacts.forEach((c) => {
      c.status = false;
    });
    await this.context.globalState.update("contacts", this.contacts);
    return this.contacts;
  }

  public async deleteContact(c: StoredContact): Promise<StoredContact[]> {
    this.contacts = this.contacts.filter(
      (x) =>
        !(
          x.ip === c?.ip &&
          (x.port || ChatDataStore.DEFAULT_PORT) ===
            (c.port || ChatDataStore.DEFAULT_PORT) &&
          x.username === c?.username
        )
    );
    await this.context.globalState.update("contacts", this.contacts);
    return this.contacts;
  }

  public getChatMessages(
    limit: number = 100,
    offset: number = 0,
  ): StoredChatMessage[] {
    if (!this.chatMessages || this.chatMessages.length === 0) {
      return [];
    }
    return this.chatMessages.slice(offset, offset + limit);
  }

  public async appendChatMessage(
    message: StoredChatMessage,
  ): Promise<void> {
    if (!this.chatMessages) {
      this.chatMessages = [];
    }
    this.chatMessages.push(message);
    await this.context.globalState.update("chatMessages", this.chatMessages);
  }
}

