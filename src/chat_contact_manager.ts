import { ChatDataStore, StoredContact } from "./chat_data_store";

type Contact = StoredContact;

export interface LinkMessageResult {
  ip: string;
  port: number;
  nickname: string;
  isReply: boolean;
}

export class ChatContactManager {
  private static contacts: Contact[] = [];
  private static store: ChatDataStore;

  public static init(store: ChatDataStore) {
    this.store = store;
    this.contacts = this.store.getContacts();
  }

  public static getContacts(): Contact[] {
    return this.contacts;
  }

  public static async resetAllStatuses(): Promise<Contact[]> {
    this.contacts = await this.store.resetAllContactsStatus();
    return this.contacts;
  }

  public static async deleteContact(contact: Contact): Promise<Contact[]> {
    this.contacts = await this.store.deleteContact(contact);
    return this.contacts;
  }

  public static async handleLinkMessage(
    result: LinkMessageResult,
  ): Promise<Contact[] | undefined> {
    if (!result.isReply) {
      return;
    }

    const existingContact = this.contacts.find(
      (c) => c.ip === result.ip && c.port === result.port,
    );

    if (existingContact) {
      this.contacts = await this.store.updateContactStatus(
        result.ip,
        result.port,
        true,
      );
    } else {
      const contact: Contact = {
        ip: result.ip,
        port: result.port,
        username: result.nickname,
      };
      this.contacts = await this.store.addContact(contact);
      this.contacts = await this.store.updateContactStatus(
        result.ip,
        result.port,
        true,
      );
    }

    return this.contacts;
  }
}
