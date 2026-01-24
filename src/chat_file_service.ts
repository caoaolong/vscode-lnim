import * as fs from "fs";
import { ChatMessage, ChatMessageService } from "./chat_message_service";
import * as path from "path";
import * as vscode from "vscode";
import { ChatFileBuffer } from "./chat_file_buffer";

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

export interface ChatFileMetadata {
  ip: string;
  port: number;
  username: string;
  path: string;
  fd?: number;
}

export interface ReceivedFile {
  path: string;
  name: string;
  size: number;
  sender: string;
  ip: string;
  completed: boolean; // 新增：标记文件是否接收完成
}

export interface FileSession {
  fd: number;
  sessionId: string;
  size: number;
  received: number;
  buffer: ChatFileBuffer;
}

export class ChatFileService {
  // 优化chunk大小以适应MTU限制，避免IP分片
  private readonly chunkSize: number = 256;
  private fds: Map<string, FileSession> = new Map();

  rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    fs.mkdirSync(`${this.rootPath}/files`, { recursive: true });
  }

  public createSession(msg: ChatMessage) {
    if (!msg.fd || !msg.unique || !msg.value) {
      return;
    }
    const session: FileSession = {
      fd: msg.fd,
      sessionId: msg.unique,
      size: parseInt(msg.value),
      received: 0,
      buffer: new ChatFileBuffer(msg.fd),
    };
    this.fds.set(msg.unique, session);
  }

  closeSession(msg: ChatMessage) {
    if (!msg.fd || !msg.unique) {
      return;
    }
    const session = this.fds.get(msg.unique);
    if (!session) {
      return;
    }
    session.buffer.flush();
    fs.closeSync(session.fd);
    this.fds.delete(msg.unique);
  }

  public dispose(): void {
    // 关闭所有文件句柄
    for (const [filePath, session] of this.fds.entries()) {
      try {
        fs.closeSync(session.fd);
      } catch (error) {
        console.error(`关闭文件句柄失败 ${filePath}:`, error);
      }
    }
    this.fds.clear();
  }

  /**
   * 获取安全的相对路径，支持跨平台路径处理
   */
  private getSafeRelativePath(filePath: string): string {
    const winDriveMatch = filePath.match(/^[a-zA-Z]:\\/);
    if (winDriveMatch) {
      const withoutDrive = filePath.substring(3);
      return withoutDrive.replace(/\\/g, "/");
    }

    if (filePath.startsWith("/")) {
      return filePath.substring(1);
    }

    return filePath.replace(/\\/g, "/");
  }

  /**
   * 在编辑器中打开文件
   */
  private async openFileInEditor(filePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand("vscode.open", uri);
    } catch (error) {
      vscode.window.showErrorMessage(
        `无法打开文件: ${path.basename(filePath)}`,
      );
      console.error("打开文件失败:", error);
    }
  }

  /**
   * 获取所有接收的文件列表（包括完成状态）
   */
  public getFiles(): ReceivedFile[] {
    const files: ReceivedFile[] = [];
    console.log(`[ChatFileService] 扫描接收文件目录: ${this.rootPath}`);
    if (!fs.existsSync(this.rootPath)) {
      return files;
    }

    try {
      // 扫描根目录下的所有目录（格式为 ${ip}）
      const entries = fs.readdirSync(this.rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const ip = entry.name;
        const dirPath = path.join(this.rootPath, ip);
        // 递归扫描目录下的所有文件
        this.scanDirectoryForFiles(dirPath, ip, files);
      }
    } catch (error) {
      console.error("获取文件列表失败:", error);
    }
    return files;
  }

  /**
   * 递归扫描目录中的文件
   */
  private scanDirectoryForFiles(
    dirPath: string,
    ip: string,
    files: ReceivedFile[],
  ): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          this.scanDirectoryForFiles(fullPath, ip, files);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
          const relativePath = path.relative(
            path.join(this.rootPath, ip),
            fullPath,
          );

          files.push({
            path: fullPath,
            name: entry.name,
            size: stats.size,
            sender: ip,
            ip,
            completed: true, // 简化：假设已下载的文件都是完整的
          });
        }
      }
    } catch (error) {
      console.error(`扫描目录失败 ${dirPath}:`, error);
    }
  }

  /**
   * 删除文件
   */
  public async deleteFile(filePath: string): Promise<boolean> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);

        // 如果文件所在目录为空，尝试删除目录
        const dirPath = path.dirname(filePath);
        try {
          const dirEntries = fs.readdirSync(dirPath);
          if (dirEntries.length === 0) {
            fs.rmdirSync(dirPath);
          }
        } catch {
          // 忽略删除目录的错误
        }

        return true;
      }
      return false;
    } catch (error) {
      console.error("删除文件失败:", error);
      return false;
    }
  }

  /**
   * 打开文件
   */
  public async openFile(filePath: string): Promise<void> {
    await this.openFileInEditor(filePath);
  }

  /**
   * 下载文件
   */
  public async download(
    file: ChatFileMetadata,
    messageService: ChatMessageService,
  ): Promise<void> {
    const safePath = this.getSafeRelativePath(file.path);
    const targetPath = path.join(this.rootPath, file.ip, safePath);
    const filename = path.basename(file.path);

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
      // 文件已存在且完整
      const answer = await vscode.window.showWarningMessage(
        `文件 ${filename} 已存在，是否覆盖？`,
        { modal: true },
        "是",
        "否",
      );

      if (answer === "是") {
        fs.unlinkSync(targetPath);
      } else {
        await this.openFileInEditor(targetPath);
        return;
      }
    }

    // 创建文件并开始下载
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "");
    file.fd = fs.openSync(targetPath, "r+");
    messageService.sendFileRequest(file);
  }

  /**
   * 保存接收到的chunk
   */
  public saveChunk(sessionId: string, data: Buffer): void {
    if (!this.fds.has(sessionId)) {
      console.warn(`[saveChunk] 会话不存在: ${sessionId}`);
      return;
    }

    const session = this.fds.get(sessionId);
    if (!session) {
      return;
    }

    // TODO: 写入缓冲区
    session.buffer.write(data);
    console.log(`[saveChunk] 写入数据: ${data.length} bytes`);
  }
}
