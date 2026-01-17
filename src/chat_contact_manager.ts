import { ChatDataStore, StoredContact } from "./chat_data_store";

type Contact = StoredContact;

export interface LinkMessageResult {
  ip: string;
  port: number;
  id?: string;
  isReply: boolean;
}

export class ChatContactManager {
  private contacts: Contact[];

  constructor(
    private readonly store: ChatDataStore,
    private readonly defaultPort: number
  ) {
    this.contacts = this.store.getContacts();
  }

  public getContacts(): Contact[] {
    return this.contacts;
  }

  public async resetAllStatuses(): Promise<Contact[]> {
    this.contacts = await this.store.resetAllContactsStatus();
    return this.contacts;
  }

  public async deleteContact(contact: Contact): Promise<Contact[]> {
    this.contacts = await this.store.deleteContact(contact);
    return this.contacts;
  }

  public async handleLinkMessage(
    result: LinkMessageResult
  ): Promise<Contact[] | undefined> {
    if (!result.isReply) {
      return;
    }

    const existingContact = this.contacts.find(
      (c) =>
        c.ip === result.ip &&
        (c.port || this.defaultPort) === (result.port || this.defaultPort)
    );

    if (existingContact) {
      this.contacts = await this.store.updateContactStatus(
        result.ip,
        result.port,
        true
      );
    } else if (result.id) {
      let username = `用户_${result.ip}`;
      try {
        const decoded = Buffer.from(result.id, "base64").toString("utf8");
        const parts = decoded.split(":");
        if (parts.length > 0 && parts[0]) {
          username = parts[0];
        }
      } catch {
      }

      const contact: Contact = {
        ip: result.ip,
        port: result.port,
        username,
      };
      this.contacts = await this.store.addContact(contact);
      this.contacts = await this.store.updateContactStatus(
        result.ip,
        result.port,
        true
      );
    }

    return this.contacts;
  }
}

