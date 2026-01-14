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
    this.contacts = this.context.globalState.get<StoredContact[]>(
      "contacts",
      []
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
        this.contacts.push(c);
        await this.context.globalState.update("contacts", this.contacts);
      }
    }
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
}

