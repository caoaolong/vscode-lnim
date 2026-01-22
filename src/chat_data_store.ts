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

export class ChatDataStore {
  private static readonly DEFAULT_PORT = 18080;

  private userSettings: StoredUserSettings;
  private contacts: StoredContact[];

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
        this.contacts.push(c);
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

  public async updateContact(
    ip: string,
    port: number | undefined,
    updates: { status?: boolean; username?: string }
  ): Promise<StoredContact[]> {
    const targetPort = port || ChatDataStore.DEFAULT_PORT;
    const contact = this.contacts.find(
      (c) => c.ip === ip && (c.port || ChatDataStore.DEFAULT_PORT) === targetPort
    );
    if (contact) {
      if (updates.status !== undefined) {
        contact.status = updates.status;
      }
      if (updates.username !== undefined) {
        contact.username = updates.username;
      }
      await this.context.globalState.update("contacts", this.contacts);
    }
    return this.contacts;
  }

  /**
   * 删除联系人
   * 只要IP和端口匹配就删除，因为同一个IP+端口必定是同一个用户
   */
  public async deleteContact(c: StoredContact): Promise<StoredContact[]> {
    const targetPort = c.port || ChatDataStore.DEFAULT_PORT;
    this.contacts = this.contacts.filter(
      (x) =>
        !(
          x.ip === c?.ip &&
          (x.port || ChatDataStore.DEFAULT_PORT) === targetPort
        )
    );
    await this.context.globalState.update("contacts", this.contacts);
    return this.contacts;
  }

  /**
   * 通过IP和端口删除联系人（便捷方法）
   */
  public async deleteContactByAddress(ip: string, port: number): Promise<StoredContact[]> {
    const targetPort = port || ChatDataStore.DEFAULT_PORT;
    this.contacts = this.contacts.filter(
      (x) =>
        !(
          x.ip === ip &&
          (x.port || ChatDataStore.DEFAULT_PORT) === targetPort
        )
    );
    await this.context.globalState.update("contacts", this.contacts);
    return this.contacts;
  }
}

