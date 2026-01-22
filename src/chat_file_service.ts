import * as fs from "fs";
import { ChatFileChunk, ChatMessage, ChatMessageService } from "./chat_message_service";
import * as path from "path";
import * as vscode from "vscode";

export interface ChatFileMetadata {
  ip: string;
  port: number;
  username: string;
  path: string;
}

export interface ReceivedFile {
  path: string;
  name: string;
  size: number;
  sender: string;
  ip: string;
  port: number;
  completed: boolean; // 新增：标记文件是否接收完成
}

interface FileSession {
  fd: number;
  sessionId: string;
  size: number;
  received: number;
  progressReport?: (value: { message?: string; increment?: number }) => void;
  fileName?: string;
}

export class ChatFileService {
  // 优化chunk大小以适应MTU限制，避免IP分片
  private readonly chunkSize: number = 256;
  private fds: Map<string, FileSession> = new Map();

  // 存储文件下载进度
  private activeDownloads = new Map<string, {
    resolve: () => void;
    report: (value: { message?: string; increment?: number }) => void;
    lastPercentage: number;
    receivedChunks: Set<number>;
    totalChunks: number;
    sessionId: string;
    senderIp: string;
    senderPort: number;
    filePath: string;
    originalFilePath: string;
    originalFileName: string;
    buffer: Buffer; // 内存缓冲区，用于批量写入
    pendingWrites: Map<number, Buffer>; // 待写入的chunk
    lastFlushTime: number; // 上次刷新时间
    flushTimer?: NodeJS.Timeout; // 刷新定时器
  }>();

  rootPath: string;
  private messageServiceRef?: ChatMessageService;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    fs.mkdirSync(`${this.rootPath}/files`, { recursive: true });
  }

  public setMessageService(messageService: ChatMessageService): void {
    this.messageServiceRef = messageService;
  }

  public updateSession(msg: ChatMessage) {
    if (msg.unique && msg.value && this.fds.has(msg.unique)) {
      const session = this.fds.get(msg.unique);
      if (session) {
        session.size = parseInt(msg.value);
        console.log(`[updateSession] 文件大小信息已收到: ${session.size}`);
        // 更新进度条显示（文件大小信息已收到）
        if (session.progressReport) {
          const percentage = session.size > 0 
            ? Math.min(100, Math.round((session.received / session.size) * 100))
            : 0;
          const receivedMB = (session.received / (1024 * 1024)).toFixed(2);
          const totalMB = (session.size / (1024 * 1024)).toFixed(2);
          const fileName = session.fileName || "文件";
          session.progressReport({
            message: `${fileName}: ${percentage}% (${receivedMB}MB / ${totalMB}MB)`,
          });
        }
      }
    }
  }

  public dispose(): void {
    // 清理所有定时器
    for (const [, session] of this.activeDownloads.entries()) {
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
      }
    }

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
      return withoutDrive.replace(/\\/g, '/');
    }

    if (filePath.startsWith('/')) {
      return filePath.substring(1);
    }

    return filePath.replace(/\\/g, '/');
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

    if (!fs.existsSync(this.rootPath)) {
      return files;
    }

    try {
      // 扫描根目录下的所有目录（格式为 ${ip}_${port}）
      const entries = fs.readdirSync(this.rootPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        // 解析目录名，提取 IP 和端口
        const dirMatch = entry.name.match(/^(.+)_(\d+)$/);
        if (!dirMatch) {
          continue;
        }

        const [, ip, portStr] = dirMatch;
        const port = parseInt(portStr, 10);
        const dirPath = path.join(this.rootPath, entry.name);

        // 递归扫描目录下的所有文件
        this.scanDirectoryForFiles(dirPath, ip, port, files);
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
    port: number,
    files: ReceivedFile[]
  ): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          this.scanDirectoryForFiles(fullPath, ip, port, files);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
          const relativePath = path.relative(
            path.join(this.rootPath, `${ip}_${port}`),
            fullPath
          );

          files.push({
            path: fullPath,
            name: entry.name,
            size: stats.size,
            sender: `${ip}:${port}`,
            ip,
            port,
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
    const targetPath = path.join(
      this.rootPath,
      file.ip,
      safePath,
    );
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
    const sessionId = messageService.sendFileRequest(file);
    
    // 启动进度条
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在接收文件: ${filename}`,
        cancellable: false,
      },
      async (progress) => {
        // 创建会话并保存进度报告函数
        const session: FileSession = {
          fd: fs.openSync(targetPath, "r+"),
          sessionId: sessionId,
          size: 0,
          received: 0,
          progressReport: (value) => progress.report(value),
          fileName: filename,
        };
        this.fds.set(sessionId, session);
        
        // 等待文件传输完成（通过检查session是否还存在）
        return new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            if (!this.fds.has(sessionId)) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);
        });
      }
    );
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

    try {
      // 将数据写入文件（从当前已接收位置开始）
      const bytesWritten = fs.writeSync(session.fd, data, 0, data.length, session.received);
      
      // 更新已接收字节数
      session.received += bytesWritten;
      
      // 计算传输进度
      let percentage = 0;
      if (session.size > 0) {
        percentage = Math.min(100, Math.round((session.received / session.size) * 100));
      }
      
      // 使用VSCode进度条显示传输进度
      if (session.progressReport) {
        const receivedMB = (session.received / (1024 * 1024)).toFixed(2);
        const totalMB = session.size > 0 ? (session.size / (1024 * 1024)).toFixed(2) : "?";
        const fileName = session.fileName || "文件";
        const message = session.size > 0 
          ? `${fileName}: ${percentage}% (${receivedMB}MB / ${totalMB}MB)`
          : `${fileName}: ${receivedMB}MB (等待文件大小信息...)`;
        
        session.progressReport({
          message: message,
          increment: 0, // 手动计算百分比，不使用increment
        });
      }
      
      // 检查是否接收完成
      if (session.size > 0 && session.received >= session.size) {
        // 显示完成消息
        if (session.progressReport) {
          const fileName = session.fileName || "文件";
          session.progressReport({
            message: `${fileName}: 接收完成 (${(session.size / (1024 * 1024)).toFixed(2)}MB)`,
          });
        }
        
        // 关闭文件句柄
        fs.closeSync(session.fd);
        
        // 清理会话（这会触发进度条的Promise resolve）
        this.fds.delete(sessionId);
        
        // 通知UI更新文件列表（如果有messageServiceRef）
        if (this.messageServiceRef) {
          this.messageServiceRef.notifyFilesUpdated(this.getFiles());
        }
      }
    } catch (error) {
      console.error(`[saveChunk] 写入文件失败 - 会话ID: ${sessionId}:`, error);
      
      // 显示错误消息
      if (session.progressReport) {
        const fileName = session.fileName || "文件";
        session.progressReport({
          message: `${fileName}: 接收失败 - ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      
      // 发生错误时清理会话
      try {
        fs.closeSync(session.fd);
      } catch (closeError) {
        // 忽略关闭错误
      }
      this.fds.delete(sessionId);
    }
  }
}
