import * as fs from "fs";

export class ChatFileBuffer {
  private fd: number;
  private readonly buffer: Buffer;
  private offset: number = 0;
  private readonly maxSize: number = 1024 * 1024; // 1MB

  constructor(fd: number) {
    this.fd = fd;
    this.buffer = Buffer.alloc(this.maxSize);
  }

  public async write(data: Buffer): Promise<void> {
    // 如果当前数据超过缓冲区剩余空间
    if (this.offset + data.length > this.maxSize) {
      // 先刷新缓冲区
      await this.flush();

      // 如果单次数据量直接超过缓冲区大小，直接写入
      if (data.length > this.maxSize) {
        fs.writeFileSync(this.fd, data, { flag: "a" });
        return;
      }
    }

    // 写入缓冲区
    data.copy(this.buffer, this.offset);
    this.offset += data.length;
  }

  public async flush(): Promise<void> {
    if (this.offset > 0 && this.fd !== null) {
      const dataToFlush = this.buffer.subarray(0, this.offset);
      // 等待回调完成，确保数据已处理
      fs.writeFileSync(this.fd, dataToFlush, { flag: "a" });
      this.offset = 0;
    }
  }
}
