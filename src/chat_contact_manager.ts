import * as net from "net";
import { ChatDataStore, StoredContact } from "./chat_data_store";

type Contact = StoredContact;

export interface LinkMessageResult {
  ip: string;
  port: number;
  nickname: string;
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

  /**
   * 删除联系人
   * 只根据IP和端口删除，因为同一个IP+端口必定是同一个用户
   */
  public static async deleteContact(contact: Contact): Promise<Contact[]> {
    this.contacts = await this.store.deleteContact(contact);
    return this.contacts;
  }

  /**
   * 通过IP和端口删除联系人（便捷方法）
   */
  public static async deleteContactByAddress(ip: string, port: number): Promise<Contact[]> {
    this.contacts = await this.store.deleteContactByAddress(ip, port);
    return this.contacts;
  }

  public static async handleLinkMessage(
    result: LinkMessageResult
  ): Promise<Contact[] | undefined> {
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
        status: true
      };
      this.contacts = await this.store.addContact(contact);
    }
    return this.contacts;
  }
}
